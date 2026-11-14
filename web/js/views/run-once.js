// What the bench and the guided view share when they ask the model: one call at a time, the run
// checked first, the answer recorded once in History, and an expired session in accounts mode
// leading to sign-in. The models keep their own state; this calls their hooks.
import { HREF } from '../routes.js';
import { messageOf, RunError } from '../run-error.js';
import { validateRun } from '../systemone.js';

// The History entry for one run and its result (ruling R14; reply is stored as it is). The
// request is the run itself, so it is not kept twice; History derives it.
const historyEntry = ({ id, at, guided, run: held, result }) => {
  // Pictures are not kept: only what a preview needs.
  const { pictures = [], ...run } = held;
  const parts = pictures.map(({ preview, width, height, bytes }) => (preview ? { preview, width, height, bytes } : { width, height, bytes }));
  const reply = {
    answers: result.answers,
    model: result.model,
    inputTokens: result.inputTokens,
    upstreamMs: result.upstreamMs,
    response: result.response,
  };
  return { id, at, guided, run, reply, totalMs: result.totalMs, ...(parts.length ? { pictures: parts } : {}) };
};

const hasPreviews = (entry) => (entry.pictures ?? []).some((p) => p.preview);
const withoutPreviews = (entry) => ({ ...entry, pictures: entry.pictures.map(({ width, height, bytes }) => ({ width, height, bytes })) });

export function createRunOnce({ client, store, now, uuid, mode, navigate, guided }) {
  let inFlight = false;
  // The call in flight: { controller, hooks, stopped }.
  let current = null;

  const failed = (e, fail) => {
    fail(messageOf(e));
    if (e instanceof RunError && e.kind === 'auth' && mode === 'accounts') navigate(HREF.signIn);
  };

  return {
    get busy() {
      return inFlight;
    },
    // Gives up waiting for the call in flight: its answer is ignored and nothing is saved.
    stop() {
      if (!current) return;
      const mine = current;
      current = null;
      inFlight = false;
      mine.stopped = true;
      mine.controller.abort();
      mine.hooks.stopped?.();
    },
    // hooks: start() when the call goes out, done(result) when it is back, fail(sentence) on
    // a refused run, a failed call, or a failed save (after done); saved(entry) once the entry is
    // in History, optional; stopped() after stop(), optional.
    async send(run, hooks) {
      const { start, done, fail, saved } = hooks;
      if (inFlight) return;
      const problem = validateRun(run);
      if (problem) {
        fail(problem);
        return;
      }
      const mine = { controller: new AbortController(), hooks, stopped: false };
      current = mine;
      inFlight = true;
      start();
      let result;
      try {
        result = await client.run(run, { signal: mine.controller.signal });
      } catch (e) {
        if (mine.stopped) return;
        current = null;
        inFlight = false;
        failed(e, fail);
        return;
      }
      if (mine.stopped) return;
      current = null;
      inFlight = false;
      done(result);
      let entry = historyEntry({ id: uuid(), at: now().toISOString(), guided, run, result });
      try {
        await store.saveEntry(entry);
      } catch (first) {
        // Previews are what makes a picture run's entry large; without them it may still fit.
        const again = first instanceof RunError && first.kind === 'validation' && hasPreviews(entry);
        if (!again) {
          failed(first, fail);
          return;
        }
        entry = withoutPreviews(entry);
        try {
          await store.saveEntry(entry);
        } catch (e) {
          failed(e, fail);
          return;
        }
      }
      saved?.(entry);
    },
  };
}
