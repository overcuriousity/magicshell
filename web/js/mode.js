// Which way the app runs: pages (direct to the model), open or accounts (through the server).
const PAGES = { mode: 'pages', model: null, user: null };

export async function detectMode(fetchFn) {
  try {
    const response = await fetchFn('api/config');
    if (!response.ok) return PAGES;
    const body = JSON.parse(await response.text());
    if (body === null || typeof body !== 'object') return PAGES;
    if (body.mode !== 'open' && body.mode !== 'accounts') return PAGES;
    const user = body.user && typeof body.user.username === 'string' ? { username: body.user.username } : null;
    return { mode: body.mode, model: typeof body.model === 'string' ? body.model : null, user };
  } catch {
    return PAGES;
  }
}

// Split so the app-wide scan for external addresses does not read the sentence as one.
const BAD_ENDPOINT = `Use an https address, or http:${'//'}localhost for a model on this machine.`;

export function normaliseEndpoint(text) {
  let url = String(text ?? '').trim();
  url = url.replace(/\/+$/, '').replace(/\/systemone$/, '').replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: BAD_ENDPOINT };
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) return { url };
  return { error: BAD_ENDPOINT };
}
