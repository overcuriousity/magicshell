// The browser talks to this app's own server, in both modes.
import { shortPicture } from './pictures.js';
import { OFFLINE, RunError, serverSentence as sentence } from './run-error.js';
import { checkOutcome } from './systemone.js';

export { RunError };

const KINDS = { 401: 'auth', 413: 'validation', 422: 'validation', 429: 'limit' };

function send(fetchFn, url, body, signal) {
  const init = { method: 'POST' };
  if (body !== undefined) Object.assign(init, { headers: { 'Content-Type': 'application/json' }, body });
  if (signal) init.signal = signal;
  return fetchFn(url, init).catch(() => {
    if (signal?.aborted) throw new RunError('', 'stopped');
    throw new RunError(OFFLINE, 'network');
  });
}

export const hasPictures = (run) => (run?.pictures?.length ?? 0) > 0;

// Only what the server accepts: it denies unknown fields. The pictures a run holds in the page go
// as `images`, each written by `image`.
function wire(run, image) {
  return {
    state: run.state,
    ...(hasPictures(run) ? { images: run.pictures.map(image) } : {}),
    questions: run.questions.map((q) => {
      const out = { key: q.key, type: q.type, text: q.text };
      if (q.options) out.options = q.options.map((o) => ({ id: o.id, name: o.name, description: o.description }));
      if (q.levels) out.levels = q.levels.map((l) => ({ id: l.id, text: l.text }));
      return out;
    }),
  };
}

// The request body for a run, as this client sends it.
const bodyText = (run) => JSON.stringify(wire(run, (p) => p.url));

// The same for reading: each picture is its size, not its content.
export const requestText = (run) => JSON.stringify(wire(run, (p) => shortPicture(p.bytes)));

// `maxBytes`: the server's request size (`max_request_bytes` of its config); a longer body is
// refused here, before it is sent.
export function createServerClient(fetchFn, now = () => performance.now(), { maxBytes = Infinity } = {}) {
  // Run and Why? share the request, the checks and the reply; only the route differs.
  async function post(url, run, { signal } = {}) {
    const request = requestText(run);
    const text = bodyText(run);
    if (text.length > maxBytes / 3 && new TextEncoder().encode(text).length > maxBytes) {
      throw new RunError(`This run is too large for this server (${Math.floor(maxBytes / 1048576)} MB).`, 'validation');
    }
    const started = now();
    const reply = await send(fetchFn, url, text, signal);
    const response = await reply.text().catch(() => '');
    const totalMs = now() - started;
    if (!reply.ok) throw new RunError(sentence(response, reply.status), KINDS[reply.status] ?? 'upstream');
    let outcome;
    let body = null;
    try {
      body = JSON.parse(response);
    } catch {
      // checkOutcome reports it below.
    }
    try {
      outcome = checkOutcome(body, run);
    } catch (e) {
      throw new RunError(e.message, 'upstream');
    }
    const upstreamMs = typeof body.upstreamMs === 'number' ? body.upstreamMs : null;
    return { ...outcome, totalMs, upstreamMs, request, response };
  }
  return {
    run: (run, opts) => post('api/run', run, opts),
    why: (run) => post('api/why', run),
    async embed(texts) {
      const reply = await send(fetchFn, 'api/embed', JSON.stringify({ texts }));
      const response = await reply.text().catch(() => '');
      if (!reply.ok) throw new RunError(sentence(response, reply.status), KINDS[reply.status] ?? 'upstream');
      let body;
      try {
        body = JSON.parse(response);
      } catch {
        throw new RunError('The model endpoint sent an answer this app does not understand.', 'upstream');
      }
      if (!Array.isArray(body?.vectors) || !body.vectors.every((vector) =>
        Array.isArray(vector) && vector.every((value) => Number.isFinite(value)))) {
        throw new RunError('The model endpoint sent an answer this app does not understand.', 'upstream');
      }
      return body.vectors;
    },
    async signIn(username, password) {
      await expectNoContent(await send(fetchFn, 'api/auth/sign-in', JSON.stringify({ username, password })));
    },
    // Best effort: the server decides whether it really sends, and a failure here costs nothing.
    async preheat() {
      try {
        await send(fetchFn, 'api/preheat');
      } catch {
        // The first question simply meets a cold model.
      }
    },
    async signOut() {
      await expectNoContent(await send(fetchFn, 'api/auth/sign-out'));
    },
    async changePassword(current, next) {
      await expectNoContent(await send(fetchFn, 'api/auth/password', JSON.stringify({ current, new: next })));
    },
  };
}

async function expectNoContent(reply) {
  if (reply.status === 204) return;
  const text = await reply.text().catch(() => '');
  throw new RunError(sentence(text, reply.status), KINDS[reply.status] ?? 'upstream');
}
