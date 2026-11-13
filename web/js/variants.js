// Ready-made changes to a run and the comparison of two runs' outcomes. All functions are pure.
import { nearestLevel, noulIsYes } from './format.js';
import { copy, trimmed } from './util.js';


function mapQuestions(run, fn) {
  const out = copy(run);
  out.questions = out.questions.map(fn);
  return out;
}

export const withoutDescriptions = (run) =>
  mapQuestions(run, (q) => {
    if (q.type === 'choice') q.options = q.options.map((o) => ({ ...o, description: '' }));
    return q;
  });

// A, B, C… by position; a question has at most LIMITS.maxOptions (8) options, well within A to Z.
export const neutralNames = (run) =>
  mapQuestions(run, (q) => {
    if (q.type === 'choice') {
      q.options = q.options.map((o, i) => ({
        ...o,
        name: String.fromCharCode(65 + i),
        description: trimmed(o.description) || trimmed(o.name),
      }));
    }
    return q;
  });

export const reversedOrder = (run) =>
  mapQuestions(run, (q) => {
    if (q.type === 'choice') q.options = [...q.options].reverse();
    else if (q.type === 'score') q.levels = [...q.levels].reverse();
    return q;
  });

export const VARIANTS = [
  { id: 'bare', label: 'Without descriptions', apply: withoutDescriptions },
  { id: 'neutral', label: 'Neutral names', apply: neutralNames },
  { id: 'reversed', label: 'Reversed order', apply: reversedOrder },
];

// The option the answer picked, by that run's own option names: its id, or its place in the list
// when it has none; null when the answer names no option of the run.
function pickedId(question, answer) {
  const i = question.options.findIndex((o) => trimmed(o.name) === trimmed(answer.choice));
  if (i < 0) return null;
  return question.options[i].id ?? `#${i}`;
}

function compareChoice(qa, a, qb, b) {
  const pa = new Map(qa.options.map((o, i) => [o.id, a.probabilities[i]]));
  const pb = new Map(qb.options.map((o, i) => [o.id, b.probabilities[i]]));
  const deltas = qa.options
    .filter((o) => pb.has(o.id))
    .map((o) => ({ id: o.id, delta: pb.get(o.id) - pa.get(o.id) }));
  const picked = [pickedId(qa, a), pickedId(qb, b)];
  // A pick that cannot be found is unknown, not unchanged.
  return { pickChanged: picked.includes(null) ? null : picked[0] !== picked[1], deltas };
}

function compareScore(qa, a, qb, b) {
  const levelId = (q, score) => q.levels[nearestLevel(score, q.levels.length)].id;
  const pickChanged = levelId(qa, a.score) !== levelId(qb, b.score);
  const idsA = qa.levels.map((l) => l.id);
  const idsB = qb.levels.map((l) => l.id);
  const same = idsA.length === idsB.length && new Set(idsA).size === idsA.length && idsB.every((id) => idsA.includes(id));
  if (!same) return { pickChanged, scoreDelta: null };
  const recomputed = qb.levels.reduce((sum, l, i) => sum + b.probabilities[i] * idsA.indexOf(l.id), 0);
  return { pickChanged, scoreDelta: recomputed - a.score };
}

export function compare(runA, outA, runB, outB) {
  const result = Object.create(null);
  for (const qa of runA.questions) {
    const qb = runB.questions.find((q) => q.key === qa.key);
    const a = outA.answers[qa.key];
    const b = outB.answers[qa.key];
    if (!qb || qb.type !== qa.type || !a || !b) {
      result[qa.key] = null;
    } else if (qa.type === 'choice') {
      result[qa.key] = compareChoice(qa, a, qb, b);
    } else if (qa.type === 'score') {
      result[qa.key] = compareScore(qa, a, qb, b);
    } else {
      result[qa.key] = { pickChanged: noulIsYes(a.noul) !== noulIsYes(b.noul), delta: b.noul - a.noul };
    }
  }
  return result;
}
