// Checks runs before they are sent and the server's replies. See fixtures/systemone for the shared cases.
import { isObject, trimmed } from './util.js';

const BAD_ANSWER = 'The model endpoint sent an answer this app does not understand.';
const BAD_PICTURE = 'A picture in this request cannot be read. Add it again.';
const PICTURE_PREFIX = 'data:image/jpeg;base64,';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// The decoded size of a JPEG data URL, from its length and padding; null when it is not one.
// "/9j/" is how the JPEG magic bytes FF D8 FF begin in base64.
export function dataUrlBytes(url) {
  if (typeof url !== 'string' || !url.startsWith(PICTURE_PREFIX)) return null;
  const data = url.slice(PICTURE_PREFIX.length);
  if (!BASE64.test(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}


// A key becomes a JSON object key; any text but blank will do.
export const keyOk = (k) => typeof k === 'string' && k.trim() !== '';

// Returns the first problem as a sentence, or null. The first sentence in the list wins:
// run-level checks first, then each question in order with its own checks in list order.
// Only what the request needs is checked; how many and how long is the endpoint's to judge.
export function validateRun(run, { allowEmptyText = false } = {}) {
  const questions = run.questions;
  if (questions.length < 1) return 'Add at least one question.';
  // A run in the page holds `pictures`; on the wire they are `images`.
  const images = run.images ?? (run.pictures ?? []).map((p) => p.url);
  for (const image of images) {
    if (dataUrlBytes(image) === null || !image.startsWith(`${PICTURE_PREFIX}/9j/`)) return BAD_PICTURE;
  }
  const keys = questions.map((q) => q.key);
  if (new Set(keys).size !== keys.length) return 'Name each question differently.';
  if (!keys.every(keyOk)) return 'Give every question a key.';
  for (const q of questions) {
    const problem = validateQuestion(q, allowEmptyText);
    if (problem) return problem;
  }
  return null;
}

function validateQuestion(q, allowEmptyText) {
  if (trimmed(q.text) === '' && !allowEmptyText) return 'Type a question first.';
  if (q.type === 'choice') {
    const names = (q.options ?? []).map((o) => trimmed(o.name));
    if (names.some((n) => n === '')) return 'Name every option.';
    const seen = new Set();
    for (const n of names) {
      if (seen.has(n)) return `Use each option only once: "${n}".`;
      seen.add(n);
    }
  } else if (q.type === 'score') {
    if ((q.levels ?? []).some((l) => trimmed(l.text) === '')) return 'Describe every level.';
  }
  return null;
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function number(v) {
  if (!isNumber(v)) throw new Error(BAD_ANSWER);
  return v;
}

// Checks a server Reply, which is already an Outcome (probabilities as arrays by position), against
// the run; returns { answers, model, inputTokens } or throws the one sentence for an unreadable answer.
export function checkOutcome(body, run) {
  if (!isObject(body) || !isObject(body.answers)) throw new Error(BAD_ANSWER);
  const numbers = (v, n) => {
    if (!Array.isArray(v) || v.length !== n || !v.every(isNumber)) throw new Error(BAD_ANSWER);
    return v;
  };
  const answers = Object.create(null);
  for (const q of run.questions) {
    const a = has(body.answers, q.key) ? body.answers[q.key] : undefined;
    if (!isObject(a) || a.type !== q.type) throw new Error(BAD_ANSWER);
    if (q.type === 'choice') {
      const names = q.options.map((o) => trimmed(o.name));
      if (typeof a.choice !== 'string' || !names.includes(a.choice)) throw new Error(BAD_ANSWER);
      answers[q.key] = {
        type: 'choice',
        choice: a.choice,
        probabilities: numbers(a.probabilities, names.length),
        confidence: number(a.confidence),
      };
    } else if (q.type === 'score') {
      answers[q.key] = {
        type: 'score',
        score: number(a.score),
        probabilities: numbers(a.probabilities, q.levels.length),
        confidence: number(a.confidence),
      };
    } else {
      answers[q.key] = { type: 'noul', noul: number(a.noul) };
    }
  }
  return {
    answers,
    model: typeof body.model === 'string' ? body.model : '',
    inputTokens: isNumber(body.inputTokens) ? body.inputTokens : 0,
  };
}
