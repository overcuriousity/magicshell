// Checks runs before they are sent and the server's replies. See fixtures/systemone for the shared cases.
import { LIMITS } from './limits.js';

const BAD_ANSWER = 'The model endpoint sent an answer this app does not understand.';

// Length in characters (code points), not UTF-16 units, so Rust's chars().count() agrees.
const len = (s) => [...s].length;
const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');

// Returns the first problem as a sentence, or null. The first sentence in the list wins:
// run-level checks first, then each question in order with its own checks in list order.
export function validateRun(run, { allowEmptyText = false } = {}) {
  const questions = run.questions;
  if (questions.length < 1) return 'Add at least one question.';
  if (questions.length > LIMITS.questions) return `Use at most ${LIMITS.questions} questions.`;
  if (len(run.state) > LIMITS.state) return 'Shorten the situation to 8,000 characters or fewer.';
  const keys = questions.map((q) => q.key);
  if (new Set(keys).size !== keys.length) return 'Name each question differently.';
  const keyOk = new RegExp(`^[a-z0-9_]{1,${LIMITS.key}}$`);
  if (!keys.every((k) => keyOk.test(k))) return 'Name each question with 1 to 30 lower-case letters, digits or _.';
  for (const q of questions) {
    const problem = validateQuestion(q, allowEmptyText);
    if (problem) return problem;
  }
  return null;
}

function validateQuestion(q, allowEmptyText) {
  const text = trimmed(q.text);
  if (text === '' && !allowEmptyText) return 'Type a question first.';
  if (len(text) > LIMITS.questionText) return 'Keep each question to 500 characters or fewer.';
  if (q.type === 'choice') {
    const options = q.options ?? [];
    if (options.length < LIMITS.minOptions) return `Add at least ${LIMITS.minOptions} options.`;
    if (options.length > LIMITS.maxOptions) return `Use at most ${LIMITS.maxOptions} options.`;
    const names = options.map((o) => trimmed(o.name));
    if (names.some((n) => n === '')) return 'Name every option.';
    if (names.some((n) => len(n) > LIMITS.optionName)) return 'Keep each option to 40 characters or fewer.';
    if (options.some((o) => len(trimmed(o.description)) > LIMITS.description)) {
      return 'Keep each description to 200 characters or fewer.';
    }
    const seen = new Set();
    for (const n of names) {
      if (seen.has(n)) return `Use each option only once: "${n}".`;
      seen.add(n);
    }
  } else if (q.type === 'score') {
    const levels = q.levels ?? [];
    if (levels.length < LIMITS.minLevels) return `Add at least ${LIMITS.minLevels} levels.`;
    if (levels.length > LIMITS.maxLevels) return `Use at most ${LIMITS.maxLevels} levels.`;
    const texts = levels.map((l) => trimmed(l.text));
    if (texts.some((t) => t === '')) return 'Describe every level.';
    if (texts.some((t) => len(t) > LIMITS.level)) return 'Keep each level to 200 characters or fewer.';
  }
  return null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
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
