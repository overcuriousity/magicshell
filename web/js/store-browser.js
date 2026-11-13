// Setups and history in localStorage. Failures keep the data in memory and clear `persistent`.
const SETUPS = 'magicshell.setups';
const HISTORY = 'magicshell.history';
const KEEP = 500;

export function createBrowserStore(storage) {
  const store = { persistent: true };

  const fail = () => {
    store.persistent = false;
  };
  const read = (key) => {
    try {
      const raw = storage.getItem(key);
      if (raw === null || raw === undefined) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      fail();
      return [];
    }
  };
  const write = (key, list) => {
    try {
      storage.setItem(key, JSON.stringify(list));
    } catch {
      fail();
    }
  };

  let setups = read(SETUPS);
  let history = read(HISTORY);
  const byNewest = (a, b) => String(b.at).localeCompare(String(a.at));
  const upsert = (list, item) => {
    const i = list.findIndex((x) => x.id === item.id);
    return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
  };

  return {
    get persistent() {
      return store.persistent;
    },
    async listSetups() {
      return structuredClone(setups);
    },
    async saveSetup(setup) {
      setups = upsert(setups, structuredClone(setup));
      write(SETUPS, setups);
    },
    async deleteSetup(id) {
      setups = setups.filter((s) => s.id !== id);
      write(SETUPS, setups);
    },
    async listHistory() {
      return structuredClone(history);
    },
    async saveEntry(entry) {
      history = upsert(history, structuredClone(entry)).sort(byNewest).slice(0, KEEP);
      write(HISTORY, history);
    },
    async deleteEntry(id) {
      history = history.filter((e) => e.id !== id);
      write(HISTORY, history);
    },
    async clearHistory() {
      history = [];
      write(HISTORY, history);
    },
  };
}
