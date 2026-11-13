// The bench's state and actions, without any DOM: run A, a variant B, their results and the error.
// The working A run is kept in sessionStorage so it survives sign-in and reload.
import { compare, VARIANTS } from '../variants.js';
import { createRunOnce } from './run-once.js';

export const SESSION_KEY = 'magicshell.bench';

// A run with its result, left by History for the bench that mounts next (the result is not kept
// in sessionStorage, so it cannot ride along any other way). Taken once.
let pending = null;
export const queueRun = (run, result) => { pending = { run, result }; };
export function takeRun() {
  const taken = pending;
  pending = null;
  return taken;
}

const copy = (v) => JSON.parse(JSON.stringify(v));
const emptyRun = () => ({ state: '', questions: [{ key: 'q1', type: 'noul', text: '' }] });

function defaultSession() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const looksLikeRun = (r) =>
  isObject(r) &&
  typeof r.state === 'string' &&
  Array.isArray(r.questions) &&
  r.questions.every(
    (q) =>
      isObject(q) &&
      typeof q.key === 'string' &&
      typeof q.text === 'string' &&
      ['choice', 'score', 'noul'].includes(q.type) &&
      (q.type !== 'choice' || (Array.isArray(q.options) && q.options.every((o) => isObject(o) && typeof o.name === 'string'))) &&
      (q.type !== 'score' || (Array.isArray(q.levels) && q.levels.every((l) => isObject(l) && typeof l.text === 'string'))),
  );

// Only the fields a run has, so a setup's id, name or builtin flag never ride along.
function runOf(state, questions) {
  return {
    state,
    questions: questions.map((q) => {
      const out = { key: q.key, type: q.type, text: q.text };
      if (q.type === 'choice') out.options = q.options.map((o) => ({ id: o.id, name: o.name, description: o.description ?? '' }));
      if (q.type === 'score') out.levels = q.levels.map((l) => ({ id: l.id, text: l.text }));
      return out;
    }),
  };
}

// Edits on a run, shared by A (through the model's methods) and B (through editVariant).
export function runEdits(uuid) {
  const find = (run, key) => run.questions.find((q) => q.key === key);
  const list = (field) => ({
    add(run, key) {
      const q = find(run, key);
      if (!q?.[field]) return;
      q[field].push(field === 'options' ? { id: uuid(), name: '', description: '' } : { id: uuid(), text: '' });
    },
    update(run, key, id, patch) {
      const item = find(run, key)?.[field]?.find((x) => x.id === id);
      if (item) Object.assign(item, patch);
    },
    move(run, key, id, delta) {
      const items = find(run, key)?.[field];
      if (!items) return;
      const from = items.findIndex((x) => x.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= items.length) return;
      const [item] = items.splice(from, 1);
      items.splice(to, 0, item);
    },
    remove(run, key, id) {
      const q = find(run, key);
      if (q?.[field]) q[field] = q[field].filter((x) => x.id !== id);
    },
  });
  const twoOptions = () => [0, 1].map(() => ({ id: uuid(), name: '', description: '' }));
  const twoLevels = () => [0, 1].map(() => ({ id: uuid(), text: '' }));
  return {
    find,
    options: list('options'),
    levels: list('levels'),
    // Switching type gives the new kind its two empty rows and drops the old kind's.
    retype(q, type) {
      if (q.type === type) return;
      q.type = type;
      if (type === 'choice') q.options = twoOptions();
      else delete q.options;
      if (type === 'score') q.levels = twoLevels();
      else delete q.levels;
    },
    newQuestion(run, type) {
      const used = new Set(run.questions.map((q) => q.key));
      let i = 1;
      while (used.has(`q${i}`)) i += 1;
      const q = { key: `q${i}`, type: 'noul', text: '' };
      this.retype(q, type);
      return q;
    },
  };
}

export function createBenchModel({
  client,
  store,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  mode = 'pages',
  navigate = () => {},
  session = defaultSession(),
}) {
  const edits = runEdits(uuid);
  const listeners = new Set();

  const restore = () => {
    try {
      const saved = JSON.parse(session?.getItem(SESSION_KEY) ?? 'null');
      if (isObject(saved) && looksLikeRun(saved.a)) return runOf(saved.a.state, saved.a.questions);
    } catch {
      // A damaged entry means a fresh bench.
    }
    return emptyRun();
  };

  const state = {
    a: restore(),
    b: null,
    variant: null,
    ranA: null,
    ranB: null,
    resultA: null,
    resultB: null,
    busy: null,
    error: null,
    // Which run the error belongs to: 'a' or 'b', so the view can show it beside that run.
    errorFor: null,
  };

  const persist = () => {
    try {
      session?.setItem(SESSION_KEY, JSON.stringify({ a: state.a }));
    } catch {
      // Without session storage the bench still works; it just does not survive a reload.
    }
  };
  const changed = () => {
    persist();
    for (const fn of listeners) fn(state);
  };
  const editA = (fn) => {
    fn(state.a);
    changed();
  };

  const runner = createRunOnce({ client, store, now, uuid, mode, navigate, guided: false });

  // Validates, calls the model, and on success hands the result to `done`; run-once records it.
  const send = (which, run, done) =>
    runner.send(run, {
      start() {
        state.busy = which;
        state.error = null;
        state.errorFor = null;
        changed();
      },
      done(result) {
        state.busy = null;
        done(result);
        changed();
      },
      fail(sentence) {
        state.busy = null;
        state.error = sentence;
        state.errorFor = which;
        changed();
      },
    });

  const model = {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    setState: (text) => editA((a) => { a.state = text; }),
    addQuestion: (type) => editA((a) => { a.questions.push(edits.newQuestion(a, type)); }),
    updateQuestion(key, patch) {
      const q = edits.find(state.a, key);
      if (!q) return;
      if ('key' in patch && patch.key !== key && edits.find(state.a, patch.key)) {
        state.error = 'Name each question differently.';
        state.errorFor = 'a';
        changed();
        return;
      }
      if ('key' in patch && state.error === 'Name each question differently.') {
        state.error = null;
        state.errorFor = null;
      }
      editA(() => {
        const { type, ...rest } = patch;
        if (type) edits.retype(q, type);
        Object.assign(q, rest);
      });
    },
    removeQuestion: (key) => editA((a) => { a.questions = a.questions.filter((q) => q.key !== key); }),
    addOption: (key) => editA((a) => edits.options.add(a, key)),
    updateOption: (key, id, patch) => editA((a) => edits.options.update(a, key, id, patch)),
    moveOption: (key, id, delta) => editA((a) => edits.options.move(a, key, id, delta)),
    removeOption: (key, id) => editA((a) => edits.options.remove(a, key, id)),
    addLevel: (key) => editA((a) => edits.levels.add(a, key)),
    updateLevel: (key, id, patch) => editA((a) => edits.levels.update(a, key, id, patch)),
    moveLevel: (key, id, delta) => editA((a) => edits.levels.move(a, key, id, delta)),
    removeLevel: (key, id) => editA((a) => edits.levels.remove(a, key, id)),

    loadSetup(setup) {
      state.a = runOf(setup.sampleState ?? '', copy(setup.questions));
      state.error = null;
      state.errorFor = null;
      changed();
    },
    loadRun(run, result = null) {
      state.a = runOf(run.state, copy(run.questions));
      state.ranA = result ? copy(state.a) : null;
      state.resultA = result;
      model.dropVariant();
    },

    run() {
      const run = copy(state.a);
      return send('a', run, (result) => {
        state.ranA = run;
        state.resultA = result;
        state.b = null;
        state.variant = null;
        state.ranB = null;
        state.resultB = null;
      });
    },
    startVariant(variantId) {
      if (state.busy || !state.ranA) return;
      const ready = VARIANTS.find((v) => v.id === variantId);
      state.b = ready ? ready.apply(state.ranA) : copy(state.ranA);
      state.variant = ready ? ready.id : null;
      state.ranB = null;
      state.resultB = null;
      state.error = null;
      state.errorFor = null;
      changed();
    },
    editVariant(fn) {
      if (!state.b) return;
      fn(state.b);
      changed();
    },
    runVariant() {
      if (!state.b) return Promise.resolve();
      const run = copy(state.b);
      return send('b', run, (result) => {
        state.ranB = run;
        state.resultB = result;
      });
    },
    dropVariant() {
      state.b = null;
      state.variant = null;
      state.ranB = null;
      state.resultB = null;
      changed();
    },
    diff() {
      if (!state.resultA || !state.resultB) return null;
      return compare(state.ranA, state.resultA, state.ranB, state.resultB);
    },
    edits,
  };
  return model;
}
