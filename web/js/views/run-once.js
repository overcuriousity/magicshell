// What the bench and the guided view share when they ask the model: one call at a time, the run
// checked first, the answer recorded once in History, and an expired session in accounts mode
// leading to sign-in. The models keep their own state; this calls their hooks.
import { messageOf, RunError } from '../run-error.js';
import { validateRun } from '../systemone.js';

// The History entry for one run and its result (ruling R14; reply is stored as it is). The
// request is the run itself, so it is not kept twice; History derives it.
const historyEntry = ({ id, at, guided, run, result }) => {
  const reply = {
    answers: result.answers,
    model: result.model,
    inputTokens: result.inputTokens,
    upstreamMs: result.upstreamMs,
    response: result.response,
  };
  return { id, at, guided, run, reply, totalMs: result.totalMs };
};

export function createRunOnce({ client, store, now, uuid, mode, navigate, guided }) {
  let inFlight = false;

  const failed = (e, fail) => {
    fail(messageOf(e));
    if (e instanceof RunError && e.kind === 'auth' && mode === 'accounts') navigate('#/sign-in');
  };

  return {
    get busy() {
      return inFlight;
    },
    // hooks: start() when the call goes out, done(result) when it is back, fail(sentence) on
    // a refused run, a failed call, or a failed save (after done).
    async send(run, { start, done, fail }) {
      if (inFlight) return;
      const problem = validateRun(run);
      if (problem) {
        fail(problem);
        return;
      }
      inFlight = true;
      start();
      let result;
      try {
        result = await client.run(run);
      } catch (e) {
        inFlight = false;
        failed(e, fail);
        return;
      }
      inFlight = false;
      done(result);
      try {
        await store.saveEntry(historyEntry({ id: uuid(), at: now().toISOString(), guided, run, result }));
      } catch (e) {
        failed(e, fail);
      }
    },
  };
}
