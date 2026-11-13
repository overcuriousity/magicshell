// Modes 2 and 3: the browser talks to this app's own server.
import { RunError } from './run-error.js';
import { checkOutcome } from './systemone.js';

export { RunError };

const OFFLINE = 'The server cannot be reached. Check your connection and try again.';
const KINDS = { 401: 'auth', 413: 'validation', 422: 'validation', 429: 'limit' };

// The server's one-sentence body, or a fallback when it is empty or a web page.
function sentence(text, status) {
  const t = text.trim();
  if (t === '' || t.startsWith('<')) return `The server answered with an error (${status}). Try again later.`;
  return t;
}

function send(fetchFn, url, body) {
  const init = { method: 'POST' };
  if (body !== undefined) Object.assign(init, { headers: { 'Content-Type': 'application/json' }, body });
  return fetchFn(url, init).catch(() => {
    throw new RunError(OFFLINE, 'network');
  });
}

// Only what the server accepts: it denies unknown fields.
function wire(run) {
  return {
    state: run.state,
    questions: run.questions.map((q) => {
      const out = { key: q.key, type: q.type, text: q.text };
      if (q.options) out.options = q.options.map((o) => ({ id: o.id, name: o.name, description: o.description }));
      if (q.levels) out.levels = q.levels.map((l) => ({ id: l.id, text: l.text }));
      return out;
    }),
  };
}

export function createServerClient(fetchFn, now = () => performance.now()) {
  return {
    async run(run) {
      const request = JSON.stringify(wire(run));
      const started = now();
      const reply = await send(fetchFn, 'api/run', request);
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
    },
    async signIn(username, password) {
      await expectNoContent(await send(fetchFn, 'api/auth/sign-in', JSON.stringify({ username, password })));
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
