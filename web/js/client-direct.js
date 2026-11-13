// Mode 1: the browser talks System One to the model endpoint itself.
import { RunError } from './run-error.js';
import { parseResponse, requestJson, validateRun } from './systemone.js';

export { RunError };

const TIMEOUT_MS = 60_000;
const CORS =
  'The endpoint did not answer the browser. It may be unreachable or not allow cross-origin requests (CORS).';
const UNREADABLE = 'The endpoint could not be read. Try again.';
const SLOW = 'The model took too long to answer. Try again.';

function statusSentence(status) {
  switch (status) {
    case 401:
    case 403:
      return 'The model endpoint refused the key. Check it in Settings.';
    case 404:
      return 'The model endpoint does not know this model. Check it in Settings.';
    case 501:
      return 'This model is not a decision model. Check it in Settings.';
    default:
      return `The model endpoint answered with an error (${status}). Try again later.`;
  }
}

function lenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createDirectClient({ endpoint, key, model }, fetchFn, now = () => performance.now()) {
  return {
    async run(run) {
      const problem = validateRun(run);
      if (problem) throw new RunError(problem, 'validation');
      const request = requestJson(run, model);
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = `Bearer ${key}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const started = now();
      let status;
      let response;
      try {
        const reply = await fetchFn(`${endpoint}/systemone`, {
          method: 'POST',
          headers,
          body: request,
          signal: controller.signal,
        });
        status = reply.status;
        response = await reply.text();
      } catch (e) {
        if (e && e.name === 'AbortError') throw new RunError(SLOW, 'upstream');
        if (e instanceof TypeError) throw new RunError(CORS, 'network');
        throw new RunError(UNREADABLE, 'network');
      } finally {
        clearTimeout(timer);
      }
      const totalMs = now() - started;
      if (status < 200 || status > 299) throw new RunError(statusSentence(status), 'upstream');
      let outcome;
      try {
        outcome = parseResponse(lenient(response), run);
      } catch (e) {
        throw new RunError(e.message, 'upstream');
      }
      return { ...outcome, totalMs, upstreamMs: null, request, response };
    },
  };
}
