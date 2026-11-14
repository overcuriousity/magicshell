// One copy of history and setups for the grey suggestions: read once, then kept current by the
// store's own writes, so typing never waits on a request.
import { BUILTIN, SCALES } from './setups-builtin.js';
import { createSuggestions, EMPTY } from './suggest.js';

const replaceById = (list, item) => [...list.filter((x) => x.id !== item.id), item];
const without = (list, id) => list.filter((x) => x.id !== id);

// After a failed read, every field of a view asks again; the next read waits this long.
const RETRY_MS = 30_000;

export function withSuggestions(store, { builtin = BUILTIN, scales = SCALES, now = () => Date.now() } = {}) {
  let data = null; // { history, setups } once a read has succeeded
  let built = null; // Suggestions for `data`, dropped by every change
  let loading = null;
  let failedAt = null;
  // Writes that resolve while a read is in flight may be missing from what it returns: each read
  // in flight collects them and applies them to what it got.
  const reads = new Set();

  const apply = (change) => {
    if (data) {
      data = change(data);
      built = null;
    }
    for (const seen of reads) seen.push(change);
  };

  const read = () => {
    const seen = [];
    reads.add(seen);
    return Promise.all([store.listHistory(), store.listSetups()])
      .then(([history, setups]) => {
        data = seen.reduce((d, change) => change(d), { history: [...history], setups: [...setups] });
        built = null;
      })
      .finally(() => reads.delete(seen));
  };

  const load = () => {
    if (loading) return loading;
    if (failedAt !== null && now() - failedAt < RETRY_MS) return Promise.resolve();
    failedAt = null;
    loading = read().catch(() => {
      // Offer nothing, and let a load after RETRY_MS try again.
      loading = null;
      failedAt = now();
    });
    return loading;
  };

  // Reads again, for changes the store made by itself (a browser store trimming its history).
  // The old copy is offered until the read is back, and kept if it fails.
  const refresh = () => (data ? read().catch(() => {}) : load());

  const current = () => {
    if (!data) return EMPTY;
    built ??= createSuggestions({ history: data.history, setups: [...builtin, ...data.setups], scales });
    return built;
  };

  const write = (name, change) => async (arg) => {
    const result = await store[name](arg);
    apply((d) => change(d, arg));
    return result;
  };

  const wrapped = {
    ...store,
    saveEntry: write('saveEntry', (d, e) => ({ ...d, history: replaceById(d.history, e) })),
    deleteEntry: write('deleteEntry', (d, id) => ({ ...d, history: without(d.history, id) })),
    clearHistory: write('clearHistory', (d) => ({ ...d, history: [] })),
    saveSetup: write('saveSetup', (d, s) => ({ ...d, setups: replaceById(d.setups, s) })),
    deleteSetup: write('deleteSetup', (d, id) => ({ ...d, setups: without(d.setups, id) })),
    suggest: { load, refresh, current },
  };
  // A getter on the store (a browser store's `persistent`) is read each time, not copied once.
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(store))) {
    if (d.get) Object.defineProperty(wrapped, name, { get: () => store[name], enumerable: true, configurable: true });
  }
  return wrapped;
}
