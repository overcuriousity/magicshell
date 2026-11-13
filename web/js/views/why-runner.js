// Why?: asks the model once per word with that word left out, one call at a time. No DOM; the
// panel subscribes to state. Partial results are saved as the run goes and when it ends.
import { messageOf, RunError } from '../run-error.js';
import { addWord, emptyWhy, splitWords, without, WHY_SAVE_EVERY } from '../why.js';

export function createWhyRunner({ client, entry, save, onAuth = () => {} }) {
  const listeners = new Set();
  let state = { phase: 'idle', at: null, why: null, error: null };
  let stopRequested = false;

  const set = (patch) => {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn(state);
  };

  async function run() {
    const { run: request } = entry;
    const words = splitWords(request.state);
    let saved = 0;
    let error = null;
    let saveFailed = false;
    stopRequested = false;
    set({ phase: 'running', at: null, why: emptyWhy(request), error: null });

    const fail = (e) => {
      error = messageOf(e);
      if (e instanceof RunError && e.kind === 'auth') onAuth();
    };
    const saveNow = async () => {
      const why = state.why;
      try {
        await save(why);
        saved = why.done;
      } catch (e) {
        saveFailed = true;
        fail(e);
      }
    };

    for (let i = 0; i < words.length && !error && !stopRequested; i += 1) {
      set({ at: i });
      let result;
      try {
        result = await client.why({ ...request, state: without(request.state, words, i) });
      } catch (e) {
        fail(e);
        break;
      }
      if (stopRequested) break;
      set({ why: addWord(state.why, request, entry.reply.answers, result.answers) });
      if (state.why.done % WHY_SAVE_EVERY === 0) await saveNow();
    }

    set({ at: null });
    if (!saveFailed && state.why.done >= 1 && state.why.done !== saved) await saveNow();
    const finished = !error && !stopRequested;
    set({ phase: finished ? 'done' : 'stopped', error });
  }

  return {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      if (state.phase === 'running') return Promise.resolve();
      return run();
    },
    stop() {
      if (state.phase === 'running') stopRequested = true;
    },
  };
}
