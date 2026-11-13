// The tab's sessionStorage, or a stand-in in memory when the browser refuses it, so what was
// entered still survives moving between views (not a reload).
let fallback = null;

export function sessionStore() {
  try {
    const s = globalThis.sessionStorage;
    if (s) {
      s.setItem('magicshell.probe', '1');
      s.removeItem('magicshell.probe');
      return s;
    }
  } catch {
    // Blocked: memory below.
  }
  if (!fallback) {
    const m = new Map();
    fallback = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
  return fallback;
}
