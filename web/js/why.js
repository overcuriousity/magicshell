// Why?: how far each word of a situation moves a decision model's answer. Pure logic;
// the runner and the views build on these functions.
import { nearestLevel, noulIsYes, pct, scoreText } from './format.js';
import { trimmed } from './util.js';

// How many words are asked between two saves of a running Why?.
export const WHY_SAVE_EVERY = 25;

// A delta of this size (probability, or score per level step) is the full shade.
const FULL_SHADE = 0.3;
const MAX_STEP = 5;

export function splitWords(state) {
  return [...state.matchAll(/\S+/gu)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

// The state minus word i and the whitespace run after it (for the last word: the run before it).
export function without(state, words, i) {
  const last = i === words.length - 1;
  const from = last && i > 0 ? words[i - 1].end : words[i].start;
  const to = last ? words[i].end : words[i + 1].start;
  return state.slice(0, from) + state.slice(to);
}

const optionIndex = (question, answer) => {
  const name = trimmed(answer.choice);
  return question.options.findIndex((o) => trimmed(o.name) === name);
};

// The index of the answer's pick: option, nearest level, or yes (true) / no (false).
export function pickOf(question, answer) {
  if (question.type === 'choice') return optionIndex(question, answer);
  if (question.type === 'score') return nearestLevel(answer.score, question.levels.length);
  return noulIsYes(answer.noul);
}

// The quantity that is tracked, for a given pick of a choice.
const measuredFor = (question, answer, pick) => {
  if (question.type === 'choice') return answer.probabilities[pick];
  if (question.type === 'score') return answer.score;
  return answer.noul;
};

export const measured = (question, answer) => measuredFor(question, answer, pickOf(question, answer));

export function emptyWhy(run) {
  const q = {};
  for (const question of run.questions) q[question.key] = { vals: [], flips: {} };
  return { v: 1, words: splitWords(run.state).length, done: 0, q };
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

// A new why with one more word measured; base and reduced are answers by key.
export function addWord(why, run, base, reduced) {
  const index = why.done;
  const q = {};
  for (const question of run.questions) {
    const { key } = question;
    const prev = why.q[key];
    const pick = pickOf(question, base[key]);
    const flip = pickOf(question, reduced[key]);
    q[key] = {
      vals: [...prev.vals, round4(measuredFor(question, reduced[key], pick))],
      flips: flip === pick ? { ...prev.flips } : { ...prev.flips, [index]: flip },
    };
  }
  return { ...why, done: index + 1, q };
}

const flipFits = (question, flip) => {
  if (question.type === 'noul') return typeof flip === 'boolean';
  const count = question.type === 'choice' ? question.options.length : question.levels.length;
  return Number.isInteger(flip) && flip >= 0 && flip < count;
};

// True only for a part the server would accept for this run, with flips valid for each question.
export function fits(why, run) {
  if (!why || typeof why !== 'object' || why.v !== 1) return false;
  if (why.words !== splitWords(run.state).length) return false;
  if (!Number.isInteger(why.done) || why.done < 0 || why.done > why.words) return false;
  if (!why.q || typeof why.q !== 'object') return false;
  const keys = Object.keys(why.q);
  if (keys.length !== run.questions.length) return false;
  return run.questions.every((question) => {
    const entry = why.q[question.key];
    if (!entry || !Array.isArray(entry.vals) || !entry.flips || typeof entry.flips !== 'object') return false;
    if (entry.vals.length !== why.done) return false;
    if (!entry.vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
    return Object.entries(entry.flips).every(
      ([i, flip]) => /^\d+$/.test(i) && Number(i) < why.done && flipFits(question, flip),
    );
  });
}

const hasEffect = (question, delta) =>
  question.type === 'score' ? Number(delta.toFixed(1)) !== 0 : Math.round(delta * 100) !== 0;

const stepOf = (question, delta) => {
  const full = question.type === 'score' ? FULL_SHADE * (question.levels.length - 1) : FULL_SHADE;
  // toFixed guards against 0.2 * 5 landing a hair above 1.
  return Math.min(MAX_STEP, Math.ceil(Number(((Math.abs(delta) / full) * MAX_STEP).toFixed(9))));
};

// What leaving word i out did to a question; null while the word is unmeasured.
// pick is the original pick, which describe and legend name.
export function wordInfo(why, run, base, key, i) {
  if (i >= why.done) return null;
  const question = run.questions.find((x) => x.key === key);
  const before = measured(question, base[key]);
  const after = why.q[key].vals[i];
  const delta = after - before;
  const effect = hasEffect(question, delta);
  return {
    before,
    after,
    delta,
    flip: why.q[key].flips[i],
    pick: pickOf(question, base[key]),
    effect,
    step: effect ? stepOf(question, delta) : 0,
    dir: effect ? (delta < 0 ? 'towards' : 'away') : null,
  };
}

// The words with an effect or a flip, by |delta| descending, ties in reading order.
export function strongest(why, run, base, key, n = 10) {
  const out = [];
  for (let index = 0; index < why.done; index += 1) {
    const info = wordInfo(why, run, base, key, index);
    if (info.effect || info.flip !== undefined) out.push({ index, ...info });
  }
  out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.index - b.index);
  return out.slice(0, n);
}

const MINUS = '−';

function signedNumber(value, text) {
  if (Number(text) === 0) return '±0';
  return value > 0 ? `+${text}` : `${MINUS}${text.replace('-', '')}`;
}

// The numbers line of one word, e.g. "without it: sushi 47 % → 21 % (−26), pick becomes pizza".
export function describe(question, info) {
  if (question.type === 'score') {
    const change = signedNumber(info.delta, info.delta.toFixed(1));
    const head = `without it: ${scoreText(info.before)} → ${scoreText(info.after)} (${change})`;
    return info.flip === undefined ? head : `${head}, nearest becomes ${question.levels[info.flip].text}`;
  }
  const points = Math.round(info.delta * 100);
  const change = signedNumber(points, String(points));
  const label = question.type === 'choice' ? trimmed(question.options[info.pick].name) : 'yes';
  const head = `without it: ${label} ${pct(info.before)} → ${pct(info.after)} (${change})`;
  if (info.flip === undefined) return head;
  if (question.type === 'choice') return `${head}, pick becomes ${trimmed(question.options[info.flip].name)}`;
  return `${head}, answer becomes ${info.flip ? 'Yes' : 'No'}`;
}

// The label of each direction of change.
export function legend(question, answer) {
  if (question.type === 'choice') {
    const name = trimmed(question.options[pickOf(question, answer)].name);
    return { towards: `pulled towards ${name}`, away: `pulled away from ${name}` };
  }
  if (question.type === 'score') return { towards: 'raised the score', away: 'lowered the score' };
  return { towards: 'towards yes', away: 'towards no' };
}

export function canAsk(run, maxWords) {
  const count = splitWords(run.state).length;
  if (!maxWords) return { ok: false, count };
  if (count === 0) return { ok: false, count, reason: 'Why? needs a situation.' };
  if (count > maxWords) {
    return { ok: false, count, reason: `Why? works up to ${maxWords} words; this situation has ${count}.` };
  }
  return { ok: true, count };
}

export const costNote = (count) => `asks ${count} more ${count === 1 ? 'time' : 'times'}, once per word`;
