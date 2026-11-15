import { cut } from './suggest.js';

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const list = (value) => (Array.isArray(value) ? value : []);
const time = (value) => (typeof value === 'string' ? value : '');
const lower = (value) => text(value).toLowerCase();
const scaleKey = (levels) => JSON.stringify(levels.map(lower));

export function sameLevels(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length
    && a.every((level, i) => typeof level === 'string' && typeof b[i] === 'string' && lower(level) === lower(b[i]));
}

function sourceFor(sources, question, at) {
  const value = text(question.text);
  const key = value.toLowerCase();
  let source = sources.get(key);
  if (!source) {
    source = { key, text: value, last: '', options: [], scales: [] };
    sources.set(key, source);
  }
  if (at >= source.last) {
    source.last = at;
    source.text = value;
  }
  return source;
}

function addOption(source, raw, at) {
  const name = text(raw?.name);
  if (!name) return;
  const key = name.toLowerCase();
  let option = source.options.find((candidate) => candidate.name.toLowerCase() === key);
  if (!option) {
    option = { name, count: 0, last: '' };
    source.options.push(option);
  }
  option.name = name;
  option.count += 1;
  if (at >= option.last) option.last = at;
}

function addScale(source, raw, at) {
  const levels = list(raw).map((level) => text(level?.text)).filter(Boolean);
  if (levels.length === 0) return;
  const key = scaleKey(levels);
  let scale = source.scales.find((candidate) => scaleKey(candidate.levels) === key);
  if (!scale) {
    scale = { levels, count: 0, last: '' };
    source.scales.push(scale);
  }
  scale.levels = levels;
  scale.count += 1;
  if (at >= scale.last) scale.last = at;
}

function addQuestions(sources, questions, at) {
  for (const question of list(questions)) {
    if (!question || typeof question !== 'object' || !text(question.text)) continue;
    if (question.type !== 'choice' && question.type !== 'score') continue;
    const source = sourceFor(sources, question, at);
    if (question.type === 'choice') {
      for (const option of list(question.options)) addOption(source, option, at);
    } else {
      addScale(source, question.levels, at);
    }
  }
}

export function questionSources({ history = [], setups = [] } = {}) {
  const sources = new Map();
  for (const entry of list(history)) {
    if (!entry || typeof entry !== 'object' || !entry.run || typeof entry.run !== 'object') continue;
    addQuestions(sources, entry.run.questions, time(entry.at));
  }
  for (const setup of list(setups)) {
    if (!setup || typeof setup !== 'object') continue;
    addQuestions(sources, setup.questions, '');
  }
  return [...sources.values()];
}

export function embeddingText(value) {
  return cut(text(value), 2000);
}

export function normalize(vector) {
  if (!vector || typeof vector[Symbol.iterator] !== 'function') return null;
  const values = Array.from(vector);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return null;
  let squares = 0;
  for (const value of values) squares += value * value;
  const length = Math.sqrt(squares);
  if (!Number.isFinite(length) || length === 0) return null;
  return Float32Array.from(values, (value) => value / length);
}

export function embeddingBatches(texts, maxBytes = 60 * 1024) {
  const encoder = new TextEncoder();
  const batches = [];
  let batch = [];
  for (const value of list(texts)) {
    const next = [...batch, value];
    const bytes = encoder.encode(JSON.stringify({ texts: next })).length;
    if (batch.length > 0 && (batch.length === 64 || bytes > maxBytes)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(value);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function dot(a, b) {
  let value = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) value += a[i] * b[i];
  return value;
}

const better = (a, b) =>
  b.similarity - a.similarity || b.count - a.count || b.last.localeCompare(a.last) || (a.text < b.text ? -1 : 1);

function candidates(sources, vectors, query, min, values, key) {
  const found = new Map();
  for (const source of list(sources)) {
    const vector = vectors.get(source.key);
    if (!vector) continue;
    const similarity = dot(vector, query);
    if (similarity < min) continue;
    for (const value of values(source)) {
      const identity = key(value);
      let candidate = found.get(identity);
      if (!candidate) {
        candidate = { text: '', levels: null, similarity, count: 0, last: '' };
        found.set(identity, candidate);
      }
      candidate.similarity = Math.max(candidate.similarity, similarity);
      candidate.count += value.count;
      if (value.last >= candidate.last) {
        candidate.last = value.last;
        candidate.text = value.name ?? JSON.stringify(value.levels);
        candidate.levels = value.levels ?? null;
      }
    }
  }
  return found;
}

export function rankOptions(sources, vectors, query, { min = 0.75, exclude = [], limit = 5 } = {}) {
  if (!query) return [];
  const excluded = new Set(list(exclude).map(lower));
  const found = candidates(sources, vectors, query, min, (source) => source.options, (option) => lower(option.name));
  return [...found.values()]
    .filter((candidate) => !excluded.has(lower(candidate.text)))
    .sort(better)
    .slice(0, limit)
    .map((candidate) => candidate.text);
}

export function rankScales(sources, vectors, query, { min = 0.75, current = [], limit = 3 } = {}) {
  if (!query) return [];
  const found = candidates(sources, vectors, query, min, (source) => source.scales, (scale) => scaleKey(scale.levels));
  return [...found.values()]
    .filter((candidate) => !sameLevels(current, candidate.levels))
    .sort(better)
    .slice(0, limit)
    .map((candidate) => candidate.levels);
}
