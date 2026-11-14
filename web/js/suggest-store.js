// One copy of history and setups for the grey suggestions: read once, then kept current by the
// store's own writes, so typing never waits on a request.
import { BUILTIN, SCALES } from './setups-builtin.js';
import { createSuggestions, EMPTY } from './suggest.js';

const replaceById = (list, item) => [...list.filter((x) => x.id !== item.id), item];
const without = (list, id) => list.filter((x) => x.id !== id);

export function withSuggestions(store, { builtin = BUILTIN, scales = SCALES } = {}) {
  let data = null; // { history, setups } once a read has succeeded
  let built = null; // Suggestions for `data`, dropped by every change
  let loading = null;
  // Writes that resolve while a read is in flight may be missing from what it returns.
  let during = null;

  const apply = (change) => {
    if (data) {
      data = change(data);
      built = null;
    } else if (during) during.push(change);
  };

  const load = () => {
    if (loading) return loading;
    during = [];
    loading = Promise.all([store.listHistory(), store.listSetups()])
      .then(([history, setups]) => {
        data = during.reduce((d, change) => change(d), { history: [...history], setups: [...setups] });
        built = null;
      })
      .catch(() => {
        // Offer nothing, and let the next load try again.
        loading = null;
      })
      .finally(() => {
        during = null;
      });
    return loading;
  };

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

  return {
    ...store,
    saveEntry: write('saveEntry', (d, e) => ({ ...d, history: replaceById(d.history, e) })),
    deleteEntry: write('deleteEntry', (d, id) => ({ ...d, history: without(d.history, id) })),
    clearHistory: write('clearHistory', (d) => ({ ...d, history: [] })),
    saveSetup: write('saveSetup', (d, s) => ({ ...d, setups: replaceById(d.setups, s) })),
    deleteSetup: write('deleteSetup', (d, id) => ({ ...d, setups: without(d.setups, id) })),
    suggest: { load, current },
  };
}
