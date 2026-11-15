// The guided view's state and actions, without any DOM: the kind, the question with its context,
// then the options or the scale (a yes-or-no question has neither and is asked from step 2), then
// the result. What was entered is kept in sessionStorage so it survives sign-in and reload;
// the result is not.
import { hasPictures } from '../client-server.js';
import { pictureMemory } from '../pictures.js';
import { SCALES } from '../setups-builtin.js';
import { isObject } from '../util.js';
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

// The guide's pictures while the tab lives; see pictureMemory.
const guidePictures = pictureMemory();

const isScale = (id) => id === 'own' || SCALES.some((s) => s.id === id);
const fresh = () => ({ step: 1, kind: 'noul', question: '', options: [], scaleId: FIRST_SCALE, levels: [], context: '', pictures: [] });
// The step that asks: a yes-or-no question has no details to set.
const lastStepOf = (kind) => (kind === 'noul' ? 2 : 3);
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
    step: Math.min(step, lastStepOf(kind)),
    kind,
    question,
    options: options.map((o) => ({ id: o.id, name: o.name, description: o.description ?? '' })),
    scaleId,
    levels: levels.map((l) => ({ id: l.id, text: l.text })),
    context,
    pictureIds: Array.isArray(saved.pictureIds) ? saved.pictureIds.filter((id) => typeof id === 'string') : [],
  };
}

export function createGuidedModel({
  client,
  store,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  mode = 'open',
  navigate = () => {},
  preheat = false,
  session = sessionStore(),
  pictures: memory = guidePictures,
}) {
  const listeners = new Set();
  // How many pictures a restored or loaded draft had that are gone; the view says so once.
  let lost = 0;
  const runner = createRunOnce({ client, store, now, uuid, mode, navigate, guided: true });

  const restore = () => {
    let draft = null;
    try {
      draft = restored(JSON.parse(session?.getItem(SESSION_KEY) ?? 'null'));
    } catch {
      // A damaged draft is no draft.
    }
    if (!draft) return fresh();
    // Pictures are found in memory by id; after a reload they are gone.
    const { pictureIds, ...rest } = draft;
    const found = memory.recall(pictureIds);
    if (!found) lost = pictureIds.length;
    return { ...rest, pictures: found ?? [] };
  };

  const state = { ...restore(), busy: false, result: null, whyOpen: false, error: null };

  const persist = () => {
    const { step, kind, question, options, scaleId, levels, context, pictures } = state;
    memory.keep(pictures);
    try {
      const kept = { step: step === 'result' ? lastStepOf(kind) : step, kind, question, options, scaleId, levels, context };
      if (pictures.length > 0) kept.pictureIds = pictures.map((p) => p.id);
      session?.setItem(SESSION_KEY, JSON.stringify(kept));
    } catch {
      // Without session storage the guide still works; it just does not survive a reload.
    }
  };
  // What is gone is forgotten at once, so the next reload does not report it again.
  if (lost > 0) persist();
  // Every step change ends in changed(), so this is the one place that sees arriving on the
  // asking step (also from the result page); edits within the step do not count again.
  const asking = () => state.step === lastStepOf(state.kind);
  let wasAsking = false;
  const preheated = () => {
    const now = asking();
    if (now && !wasAsking && preheat) client.preheat?.();
    wasAsking = now;
  };
  // The draft is kept first, so a preheat that goes wrong cannot cost it.
  const changed = () => {
    persist();
    preheated();
    for (const fn of listeners) fn(state);
  };
  // Every edit clears a sentence the last attempt left, since it may no longer hold.
  const edit = (fn) => {
    fn();
    state.error = null;
    changed();
  };

  preheated();

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
      if (!trimmed) return;
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
    setPictures: (list) => edit(() => { state.pictures = [...list]; }),
    // Gives up waiting for the answer.
    stop: () => runner.stop(),
    takeLost() {
      const n = lost;
      lost = 0;
      return n;
    },

    // The step with the Ask button: 2 for a yes-or-no question, 3 otherwise.
    lastStep: () => lastStepOf(state.kind),

    // On the last step this asks.
    next() {
      if (state.busy) return undefined;
      if (state.step === 1) {
        edit(() => { state.step = 2; });
      } else if (state.step === 2) {
        if (state.question.trim() === '') {
          state.error = 'Type a question first.';
          changed();
          return undefined;
        }
        if (model.lastStep() === 2) return model.ask();
        edit(() => { state.step = 3; });
      } else if (state.step === 3) {
        return model.ask();
      }
      return undefined;
    },
    back() {
      if (state.busy) return;
      if (state.step === 2 || state.step === 3) edit(() => { state.step -= 1; });
    },

    // Whether anything was entered: a question, an option or the context.
    holdsSomething: () => state.question.trim() !== '' || state.options.length > 0 || state.context.trim() !== '' || state.pictures.length > 0,

    toRun() {
      const q = { key: KEY, type: state.kind, text: state.question };
      if (state.kind === 'choice') q.options = state.options.map((o) => ({ id: o.id, name: o.name, description: o.description ?? '' }));
      if (state.kind === 'score') q.levels = levelsOf();
      const run = { state: state.context, questions: [q] };
      if (state.pictures.length > 0) run.pictures = [...state.pictures];
      return run;
    },

    ask() {
      const run = model.toRun();
      let mine = null;
      return runner.send(run, {
        start() {
          state.busy = true;
          state.error = null;
          changed();
        },
        done(result) {
          state.busy = false;
          mine = { question: run.questions[0], answer: result.answers[KEY], entry: null, pictures: run.pictures ?? [] };
          state.result = mine;
          state.step = 'result';
          changed();
        },
        fail(sentence) {
          state.busy = false;
          state.error = sentence;
          changed();
        },
        stopped() {
          state.busy = false;
          changed();
        },
        saved(entry) {
          // Only for the result this ask produced; a slow save must not tag a newer result.
          if (state.result !== mine) return;
          mine.entry = entry;
          changed();
        },
      });
    },
    // Why? needs the saved entry; the panel is kept across changes, so saveWhy stays quiet.
    // Why? asks once per word, and every call would read the pictures again.
    canWhy: () => Boolean(state.result) && state.result.pictures.length === 0,
    openWhy() {
      if (state.step !== 'result' || !state.result?.entry || state.whyOpen || !model.canWhy()) return;
      state.whyOpen = true;
      changed();
    },
    closeWhy() {
      if (!state.whyOpen) return;
      state.whyOpen = false;
      changed();
    },
    // The entry is the one the panel was opened for, so a late save from a closed panel still
    // lands on its own entry, never on a newer one.
    saveWhy(entry, why) {
      entry.why = why;
      return store.saveEntry(entry);
    },
    askAnother() {
      if (state.busy) return;
      edit(() => {
        state.step = 2;
        state.question = '';
        state.result = null;
        state.whyOpen = false;
      });
    },
    startOver() {
      if (state.busy) return;
      edit(() => Object.assign(state, fresh(), { result: null, whyOpen: false }));
    },

    // The reverse of toRun for a run of one question; lands on step 2. Returns false otherwise.
    load(run) {
      if (!loadable(run)) return false;
      const q = run.questions[0];
      edit(() => {
        Object.assign(state, fresh(), { result: null, whyOpen: false });
        // From History the pictures are gone and `lost` says how many; the bench hands its own over.
        lost = Number.isInteger(run.lost) && run.lost > 0 ? run.lost : 0;
        state.pictures = hasPictures(run) ? [...run.pictures] : [];
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
