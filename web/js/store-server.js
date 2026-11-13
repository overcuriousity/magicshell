// Setups and history on this app's own server (modes 2 and 3).
import { OFFLINE, RunError, serverSentence as sentence } from './run-error.js';

export function createServerStore(fetchFn) {
  async function call(method, url, body) {
    const init = { method };
    if (body !== undefined) Object.assign(init, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let reply;
    try {
      reply = await fetchFn(url, init);
    } catch {
      throw new RunError(OFFLINE, 'network');
    }
    if (reply.status === 204) return undefined;
    const text = await reply.text().catch(() => '');
    if (!reply.ok) {
      const kind = reply.status === 401 ? 'auth' : reply.status === 422 ? 'validation' : 'upstream';
      throw new RunError(sentence(text, reply.status), kind);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new RunError('The server sent an answer this app does not understand.', 'upstream');
    }
  }
  const id = (x) => encodeURIComponent(x);

  return {
    persistent: true,
    listSetups: () => call('GET', 'api/setups'),
    saveSetup: (setup) => call('PUT', `api/setups/${id(setup.id)}`, setup).then(() => undefined),
    deleteSetup: (x) => call('DELETE', `api/setups/${id(x)}`).then(() => undefined),
    listHistory: () => call('GET', 'api/history'),
    saveEntry: (entry) => call('PUT', `api/history/${id(entry.id)}`, entry).then(() => undefined),
    deleteEntry: (x) => call('DELETE', `api/history/${id(x)}`).then(() => undefined),
    clearHistory: () => call('DELETE', 'api/history').then(() => undefined),
  };
}
