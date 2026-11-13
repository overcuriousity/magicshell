// Which way the server runs: open or accounts. Without its server the app has no mode (null).
const NO_SERVER = { mode: null, model: null, user: null };

export async function detectMode(fetchFn) {
  try {
    const response = await fetchFn('api/config');
    if (!response.ok) return NO_SERVER;
    const body = JSON.parse(await response.text());
    if (body === null || typeof body !== 'object') return NO_SERVER;
    if (body.mode !== 'open' && body.mode !== 'accounts') return NO_SERVER;
    const user = body.user && typeof body.user.username === 'string' ? { username: body.user.username } : null;
    return { mode: body.mode, model: typeof body.model === 'string' ? body.model : null, user };
  } catch {
    return NO_SERVER;
  }
}
