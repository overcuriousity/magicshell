// Setup validation, export and import of setup files.
import { LIMITS } from './limits.js';
import { RunError } from './run-error.js';
import { validateRun } from './systemone.js';

const NOT_SETUPS = 'This file does not hold magicshell setups.';
const len = (s) => [...s].length;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// First problem as a sentence, or null. Mirrors PUT /api/setups.
export function validateSetup(setup) {
  const name = typeof setup.name === 'string' ? setup.name.trim() : '';
  if (name === '') return 'Name the setup.';
  if (len(name) > LIMITS.setupName) return 'Keep the setup name to 60 characters or fewer.';
  const state = typeof setup.sampleState === 'string' ? setup.sampleState : '';
  if (len(state) > LIMITS.state) return 'Shorten the situation to 8,000 characters or fewer.';
  return validateRun({ state: '', questions: setup.questions }, { allowEmptyText: true });
}

const stripIds = (q) => {
  const out = { key: q.key, type: q.type, text: q.text };
  if (q.options) out.options = q.options.map((o) => ({ name: o.name, description: o.description }));
  if (q.levels) out.levels = q.levels.map((l) => ({ text: l.text }));
  return out;
};

export function exportSetups(setups) {
  const list = setups.map((s) => ({ name: s.name, sampleState: s.sampleState, questions: s.questions.map(stripIds) }));
  return JSON.stringify({ magicshell: 2, setups: list }, null, 2);
}

// Only the known fields survive, so a file cannot smuggle others into a store.
function fresh(raw, uuid) {
  const questions = raw.questions.map((q) => {
    const out = { key: q.key, type: q.type, text: q.text };
    if (q.options) out.options = q.options.map((o) => ({ id: uuid(), name: o.name, description: o.description ?? '' }));
    if (q.levels) out.levels = q.levels.map((l) => ({ id: uuid(), text: l.text }));
    return out;
  });
  return { id: uuid(), name: raw.name.trim(), questions, sampleState: raw.sampleState ?? '' };
}

function usable(raw) {
  if (!isObject(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.questions)) return false;
  if (raw.sampleState !== undefined && typeof raw.sampleState !== 'string') return false;
  return raw.questions.every(
    (q) =>
      isObject(q) &&
      typeof q.key === 'string' &&
      typeof q.text === 'string' &&
      ['choice', 'score', 'noul'].includes(q.type) &&
      (q.options === undefined ||
        (Array.isArray(q.options) &&
          q.options.every((o) => isObject(o) && typeof o.name === 'string' && (o.description === undefined || typeof o.description === 'string')))) &&
      (q.levels === undefined || (Array.isArray(q.levels) && q.levels.every((l) => isObject(l) && typeof l.text === 'string'))),
  );
}

export function importSetups(text, uuid = () => crypto.randomUUID()) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RunError(NOT_SETUPS, 'validation');
  }
  if (!isObject(data) || data.magicshell !== 2 || !Array.isArray(data.setups)) throw new RunError(NOT_SETUPS, 'validation');
  const setups = [];
  let skipped = 0;
  for (const raw of data.setups) {
    const setup = usable(raw) ? fresh(raw, uuid) : null;
    if (setup && validateSetup(setup) === null) setups.push(setup);
    else skipped += 1;
  }
  return { setups, skipped };
}
