// The guided view's state and actions, without any DOM: three steps (kind, question, details),
// then the result. What was entered is kept in sessionStorage so it survives sign-in and reload;
// the result is not.
import { LIMITS } from '../limits.js';
import { SCALES } from '../setups-builtin.js';
import { createRunOnce } from './run-once.js';
import { sessionStore } from './session.js';

export const SESSION_KEY = 'magicshell.guided';
export const KINDS = ['noul', 'choice', 'score'];
const FIRST_SCALE = SCALES[0].id;
const KEY = 'q1';


// A run left for the guide that mounts next (by the bench switch or History), taken once.
let pending = null;
export const queueGuidedRun = (run) => { pending = run; };
export function takeGuidedRun() {
  const taken = pending;
  pending = null;
  return taken;
}

// Whether the guide can take a run: one question of a kind it asks.
export function loadable(run) {
  const q = run?.questions?.length === 1 ? run.questions[0] : null;
  return Boolean(q && KINDS.includes(q.type) && typeof q.text === 'string');
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScale = (id) => id === 'own' || SCALES.some((s) => s.id === id);
const fresh = () => ({ step: 1, kind: 'noul', question: '', options: [], scaleId: FIRST_SCALE, levels: [], context: '' });
const sameTexts = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

// A saved entry is used only if every field has the shape the guide writes.
function restored(saved) {
  if (!isObject(saved)) return null;
  const { step, kind, question, options, scaleId, levels, context } = saved;
  const ok =
    [1, 2, 3].includes(step) &&
    KINDS.includes(kind) &&
    typeof question === 'string' &&
    typeof context === 'string' &&
    isScale(scaleId) &&
    Array.isArray(options) &&
    options.every((o) => isObject(o) && typeof o.id === 'string' && typeof o.name === 'string' && typeof (o.description ?? '') === 'string') &&
    Array.isArray(levels) &&
    levels.every((l) => isObject(l) && typeof l.id === 'string' && typeof l.text === 'string');
  if (!ok) return null;
  return {
    step,
    kind,
    question,
    options: options.map((o) => ({ id: o.id, name: o.name, description: o.description ?? '' })),
    scaleId,
    levels: levels.map((l) => ({ id: l.id, text: l.text })),
    context,
  };
}

export function createGuidedModel({
  client,
  store,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  mode = 'pages',
  navigate = () => {},
  session = sessionStore(),
}) {
  const listeners = new Set();
  const runner = createRunOnce({ client, store, now, uuid, mode, navigate, guided: true });

  const restore = () => {
    try {
      return restored(JSON.parse(session?.getItem(SESSION_KEY) ?? 'null')) ?? fresh();
    } catch {
      return fresh();
    }
  };

  const state = { ...restore(), busy: false, result: null, error: null };

  const persist = () => {
    const { step, kind, question, options, scaleId, levels, context } = state;
    try {
      session?.setItem(SESSION_KEY, JSON.stringify({ step: step === 'result' ? 3 : step, kind, question, options, scaleId, levels, context }));
    } catch {
      // Without session storage the guide still works; it just does not survive a reload.
    }
  };
  const changed = () => {
    persist();
    for (const fn of listeners) fn(state);
  };
  // Every edit clears a sentence the last attempt left, since it may no longer hold.
  const edit = (fn) => {
    fn();
    state.error = null;
    changed();
  };

  const levelsOf = () => {
    if (state.scaleId === 'own') return state.levels.map((l) => ({ id: l.id, text: l.text }));
    return SCALES.find((s) => s.id === state.scaleId).levels.map((text, i) => ({ id: `l${i + 1}`, text }));
  };

  const model = {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    setKind(kind) {
      if (!KINDS.includes(kind)) return;
      edit(() => { state.kind = kind; });
    },
    setQuestion: (text) => edit(() => { state.question = text; }),
    addOption(name) {
      const trimmed = String(name ?? '').trim();
      if (!trimmed || state.options.length >= LIMITS.maxOptions) return;
      edit(() => { state.options.push({ id: uuid(), name: trimmed, description: '' }); });
    },
    removeOption: (id) => edit(() => { state.options = state.options.filter((o) => o.id !== id); }),
    setScale(id) {
      if (!isScale(id)) return;
      edit(() => {
        state.scaleId = id;
        if (id === 'own' && state.levels.length === 0) state.levels = [{ id: uuid(), text: '' }, { id: uuid(), text: '' }];
      });
    },
    setLevels: (levels) => edit(() => { state.levels = levels.map((l) => ({ id: l.id, text: l.text })); }),
    setContext: (text) => edit(() => { state.context = text; }),

    next() {
      if (state.busy) return;
      if (state.step === 1) {
        edit(() => { state.step = 2; });
      } else if (state.step === 2) {
        if (state.question.trim() === '') {
          state.error = 'Type a question first.';
          changed();
          return;
        }
        edit(() => { state.step = 3; });
      }
    },
    back() {
      if (state.busy) return;
      if (state.step === 2 || state.step === 3) edit(() => { state.step -= 1; });
    },

    // Whether anything was entered: a question, an option or the context.
    holdsSomething: () => state.question.trim() !== '' || state.options.length > 0 || state.context.trim() !== '',

    toRun() {
      const q = { key: KEY, type: state.kind, text: state.question };
      if (state.kind === 'choice') q.options = state.options.map((o) => ({ id: o.id, name: o.name, description: o.description ?? '' }));
      if (state.kind === 'score') q.levels = levelsOf();
      return { state: state.context, questions: [q] };
    },

    ask() {
      const run = model.toRun();
      return runner.send(run, {
        start() {
          state.busy = true;
          state.error = null;
          changed();
        },
        done(result) {
          state.busy = false;
          state.result = { question: run.questions[0], answer: result.answers[KEY] };
          state.step = 'result';
          changed();
        },
        fail(sentence) {
          state.busy = false;
          state.error = sentence;
          changed();
        },
      });
    },
    askAnother() {
      if (state.busy) return;
      edit(() => {
        state.step = 2;
        state.question = '';
        state.result = null;
      });
    },
    startOver() {
      if (state.busy) return;
      edit(() => Object.assign(state, fresh(), { result: null }));
    },

    // The reverse of toRun for a run of one question; lands on step 2. Returns false otherwise.
    load(run) {
      if (!loadable(run)) return false;
      const q = run.questions[0];
      edit(() => {
        Object.assign(state, fresh(), { result: null });
        state.step = 2;
        state.kind = q.type;
        state.question = q.text;
        state.context = typeof run.state === 'string' ? run.state : '';
        if (q.type === 'choice') {
          state.options = (q.options ?? []).map((o) => ({ id: o.id ?? uuid(), name: o.name, description: o.description ?? '' }));
        }
        if (q.type === 'score') {
          const texts = (q.levels ?? []).map((l) => l.text);
          const ready = SCALES.find((s) => sameTexts(s.levels, texts));
          if (ready) state.scaleId = ready.id;
          else {
            state.scaleId = 'own';
            state.levels = (q.levels ?? []).map((l) => ({ id: l.id ?? uuid(), text: l.text }));
          }
        }
      });
      return true;
    },
  };
  return model;
}
