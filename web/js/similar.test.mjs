import assert from 'node:assert/strict';
import test from 'node:test';
import {
  embeddingBatches,
  embeddingText,
  normalize,
  questionSources,
  rankOptions,
  rankScales,
  sameLevels,
} from './similar.js';

const entry = (at, ...questions) => ({ id: at, at, run: { state: '', questions } });
const choice = (text, ...names) => ({
  key: 'q', type: 'choice', text, options: names.map((name, i) => ({ id: `o${i}`, name, description: '' })),
});
const score = (text, ...levels) => ({
  key: 'q', type: 'score', text, levels: levels.map((text, i) => ({ id: `l${i}`, text })),
});
const vector = (similarity) => new Float32Array([similarity, 0]);
const query = new Float32Array([1, 0]);

test('an option scores by its most similar question, with frequency and recency breaking ties', () => {
  const sources = questionSources({ history: [
    entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza', 'sushi')),
    entry('2026-11-02T00:00:00Z', choice('Meal tonight?', 'pizza', 'ramen')),
    entry('2026-11-03T00:00:00Z', choice('Lunch?', 'pizza')),
  ] });
  const vectors = new Map(sources.map((s, i) => [s.key, new Float32Array([i === 2 ? 0.8 : 0.9, 0])]));
  assert.deepEqual(rankOptions(sources, vectors, new Float32Array([1, 0])), ['pizza', 'ramen', 'sushi']);
});

test('sources include choice and score questions, not yes/no, and combine case-only duplicates', () => {
  const sources = questionSources({
    history: [entry('2026-11-01T00:00:00Z', choice('Dinner?', 'Pizza'))],
    setups: [{ questions: [choice('dinner?', 'pizza'), { type: 'noul', text: 'Hungry?' }] }],
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].text, 'Dinner?');
  assert.deepEqual(sources[0].options.map((o) => o.name), ['pizza']);
});

test('source keys, counts, timestamps and spelling follow their uses', () => {
  const sources = questionSources({
    history: [
      entry('2026-11-01T00:00:00Z', choice('  Dinner?  ', 'Pizza')),
      entry('2026-11-03T00:00:00Z', choice('DINNER?', 'PIZZA')),
    ],
    setups: [{ questions: [choice('dinner?', 'pizza')] }],
  });
  assert.deepEqual(sources, [{
    key: 'dinner?',
    text: 'DINNER?',
    last: '2026-11-03T00:00:00Z',
    options: [{ name: 'pizza', count: 3, last: '2026-11-03T00:00:00Z' }],
    scales: [],
  }]);
});

test('Bench and guided history and built-in and saved setups all contribute uses', () => {
  const sources = questionSources({
    history: [
      { ...entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza')), kind: 'bench' },
      { ...entry('2026-11-02T00:00:00Z', choice('Dinner?', 'pizza')), kind: 'guided' },
    ],
    setups: [
      { id: 'built-in', builtin: true, questions: [choice('Dinner?', 'pizza')] },
      { id: 'saved', builtin: false, questions: [choice('Dinner?', 'pizza')] },
    ],
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].options[0].count, 4);
  assert.equal(sources[0].options[0].last, '2026-11-02T00:00:00Z');
});

test('one source can hold both options and scales', () => {
  const sources = questionSources({ history: [entry(
    '2026-11-01T00:00:00Z',
    choice('How was it?', 'good'),
    score('HOW WAS IT?', 'bad', 'good'),
  )] });
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].options.map((o) => o.name), ['good']);
  assert.deepEqual(sources[0].scales.map((s) => s.levels), [['bad', 'good']]);
});

test('malformed history, setups and questions are skipped without hiding valid data', () => {
  const sources = questionSources({
    history: [
      null,
      {},
      { at: 'x', run: null },
      { at: 'x', run: { questions: 'no' } },
      entry('2026-11-01T00:00:00Z', null, {}, { type: 'choice', text: 4 }, choice('   ', 'no'), { type: 'other', text: 'no' }),
      entry('2026-11-02T00:00:00Z', { type: 'choice', text: 'Valid?', options: [{ name: 4 }, null, { name: ' yes ' }] }),
    ],
    setups: [null, { questions: null }, { questions: [null, score('Score?', { text: 'low' }, null, { text: 'high' })] }],
  });
  assert.equal(sources.length, 2);
  const valid = sources.find((s) => s.key === 'valid?');
  assert.deepEqual(valid.options, [{ name: 'yes', count: 1, last: '2026-11-02T00:00:00Z' }]);
  assert.equal(sources.some((s) => s.key === 'hungry?'), false);
});

test('scales use their most similar source and sum counts for frequency ties', () => {
  const sources = questionSources({ history: [
    entry('2026-11-01T00:00:00Z', score('Rating?', 'Low', 'High')),
    entry('2026-11-02T00:00:00Z', score('Measurement?', 'low', 'high')),
    entry('2026-11-01T00:00:00Z', score('Other?', 'Bad', 'Good')),
    entry('2026-11-03T00:00:00Z', score('Unrelated?', 'Never', 'Always')),
  ] });
  const vectors = new Map(sources.map((s) => [s.key, vector(s.key === 'unrelated?' ? 0.6 : 0.95)]));
  assert.deepEqual(rankScales(sources, vectors, query), [['low', 'high'], ['Bad', 'Good']]);
  const rating = sources.find((s) => s.key === 'rating?');
  assert.deepEqual(rating.scales, [{ levels: ['Low', 'High'], count: 1, last: '2026-11-01T00:00:00Z' }]);
});

test('scale recency breaks frequency and similarity ties', () => {
  const sources = questionSources({ history: [
    entry('2026-11-01T00:00:00Z', score('Old?', 'old', 'scale')),
    entry('2026-11-03T00:00:00Z', score('New?', 'new', 'scale')),
  ] });
  const vectors = new Map(sources.map((s) => [s.key, vector(0.9)]));
  assert.deepEqual(rankScales(sources, vectors, query), [['new', 'scale'], ['old', 'scale']]);
});

test('scale identity is ordered and case-insensitive, and the current scale is omitted', () => {
  assert.equal(sameLevels(['Low', 'High'], [' low ', 'HIGH']), true);
  assert.equal(sameLevels(['Low', 'High'], ['High', 'Low']), false);
  assert.equal(sameLevels(['Low'], ['Low', 'High']), false);
  assert.equal(sameLevels(['Low', 4], ['Low', '4']), false);
  const sources = questionSources({ history: [
    entry('2026-11-01T00:00:00Z', score('One?', 'Low', 'High')),
    entry('2026-11-02T00:00:00Z', score('Two?', 'Bad', 'Good')),
  ] });
  const vectors = new Map(sources.map((s) => [s.key, vector(0.9)]));
  assert.deepEqual(rankScales(sources, vectors, query, { current: ['LOW', 'high'] }), [['Bad', 'Good']]);
});

test('rankScales accepts the current scale as one levels string array', () => {
  const sources = questionSources({ history: [entry('2026-11-01T00:00:00Z', score('One?', 'Low', 'High'))] });
  const vectors = new Map(sources.map((s) => [s.key, vector(0.9)]));
  assert.deepEqual(rankScales(sources, vectors, query, { current: ['LOW', 'high'] }), []);
});

test('option exclusions ignore case and defaults return the top five in deterministic order', () => {
  const sources = questionSources({ history: [entry('2026-11-01T00:00:00Z', choice('Pick?', 'f', 'e', 'd', 'c', 'b', 'a'))] });
  const vectors = new Map(sources.map((s) => [s.key, vector(0.9)]));
  assert.deepEqual(rankOptions(sources, vectors, query), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(rankOptions(sources, vectors, query, { exclude: [' B '] }), ['a', 'c', 'd', 'e', 'f']);
  assert.deepEqual(rankOptions(sources, vectors, query, { limit: 2 }), ['a', 'b']);
});

test('scale defaults return the top three in deterministic code-unit order', () => {
  const sources = questionSources({ history: [
    entry('2026-11-01T00:00:00Z', score('D?', 'd')),
    entry('2026-11-01T00:00:00Z', score('C?', 'c')),
    entry('2026-11-01T00:00:00Z', score('B?', 'b')),
    entry('2026-11-01T00:00:00Z', score('A?', 'a')),
  ] });
  const vectors = new Map(sources.map((s) => [s.key, vector(0.9)]));
  assert.deepEqual(rankScales(sources, vectors, query), [['a'], ['b'], ['c']]);
});

test('distinct scales with newline-joined label collisions still have deterministic ties', () => {
  const sources = questionSources({ history: [
    entry('2026-11-01T00:00:00Z', score('Single?', 'a\nb')),
    entry('2026-11-01T00:00:00Z', score('Double?', 'a', 'b')),
  ] });
  const vectors = new Map(sources.map((s) => [s.key, vector(0.9)]));
  assert.deepEqual(rankScales(sources, vectors, query), [['a', 'b'], ['a\nb']]);
});

test('ranking needs a query, vectors and sources at or above the threshold', () => {
  const sources = questionSources({ history: [entry('2026-11-01T00:00:00Z', choice('Pick?', 'a'))] });
  const vectors = new Map([[sources[0].key, vector(0.75)]]);
  assert.deepEqual(rankOptions(sources, vectors, null), []);
  assert.deepEqual(rankOptions(sources, new Map(), query), []);
  assert.deepEqual(rankOptions(sources, vectors, query, { min: 0.7501 }), []);
  assert.deepEqual(rankOptions(sources, vectors, query), ['a']);
  assert.deepEqual(rankScales(sources, vectors, query), []);
});

test('normalize returns a Float32Array with unit length and rejects unusable vectors', () => {
  const normalized = normalize([3, 4]);
  assert.ok(normalized instanceof Float32Array);
  assert.deepEqual(normalized, new Float32Array([0.6, 0.8]));
  assert.equal(normalize([]), null);
  assert.equal(normalize([0, 0]), null);
  assert.equal(normalize([1, Number.NaN]), null);
  assert.equal(normalize([1, Number.POSITIVE_INFINITY]), null);
  assert.equal(normalize(null), null);
});

test('embeddingText trims and cuts at 2,000 code units without splitting a surrogate pair', () => {
  assert.equal(embeddingText(`  ${'a'.repeat(2001)}  `), 'a'.repeat(2000));
  assert.equal(embeddingText(`${'a'.repeat(1999)}😀`), 'a'.repeat(1999));
  assert.equal(embeddingText(`${'a'.repeat(1998)}😀`), `${'a'.repeat(1998)}😀`);
});

test('embedding batches contain at most 64 texts and never an empty batch', () => {
  const texts = Array.from({ length: 130 }, (_, i) => `question ${i}`);
  const batches = embeddingBatches(texts);
  assert.deepEqual(batches.map((b) => b.length), [64, 64, 2]);
  assert.deepEqual(batches.flat(), texts);
  assert.equal(batches.every((b) => b.length > 0), true);
  assert.deepEqual(embeddingBatches([]), []);
});

test('embedding batches use UTF-8 JSON body bytes and keep an oversized text as a singleton', () => {
  const bytes = (texts) => new TextEncoder().encode(JSON.stringify({ texts })).length;
  const first = '"😀';
  const batches = embeddingBatches([first, 'a'], bytes([first]));
  assert.deepEqual(batches, [[first], ['a']]);
  assert.equal(bytes(batches[0]) <= bytes([first]), true);

  const huge = 'x'.repeat(200);
  assert.deepEqual(embeddingBatches([huge, 'small'], 100), [[huge], ['small']]);
});
