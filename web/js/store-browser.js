// Setups and history in localStorage. Each change reads the key again first, so two tabs keep each
// other's writes. Items of the wrong shape are left out when reading. A history that no longer
// fits drops its oldest entries until it does (down to FLOOR). When storage fails, the data stays
// in memory for this page, `persistent` turns false and `onNotSaving` is called once.
const SETUPS = 'magicshell.setups';
const HISTORY = 'magicshell.history';
const KEEP = 500;
const FLOOR = 10;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SHAPES = {
  [SETUPS]: (s) => isObject(s) && typeof s.id === 'string' && typeof s.name === 'string' && Array.isArray(s.questions),
  [HISTORY]: (e) =>
    isObject(e) &&
    typeof e.id === 'string' &&
    typeof e.at === 'string' &&
    isObject(e.run) &&
    typeof e.run.state === 'string' &&
    Array.isArray(e.run.questions) &&
    isObject(e.reply),
};

// Damaged text and a list of the wrong shape are treated alike: whatever usable items remain.
function parse(raw, key) {
  if (raw === null || raw === undefined) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.filter(SHAPES[key]) : [];
  } catch {
    return [];
  }
}

export function createBrowserStore(storage, { onNotSaving = () => {} } = {}) {
  let persistent = true;
  let ready = false;
  const lists = { [SETUPS]: [], [HISTORY]: [] };

  const lost = () => {
    if (!persistent) return;
    persistent = false;
    if (ready) onNotSaving();
  };
  // The list as stored now; once storage has failed, the copy in memory.
  const load = (key) => {
    if (!persistent) return lists[key];
    try {
      lists[key] = parse(storage.getItem(key), key);
    } catch {
      lost();
    }
    return lists[key];
  };
  const write = (key, list) => {
    try {
      storage.setItem(key, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  };
  const keep = (key, list) => {
    lists[key] = list;
    if (persistent && !write(key, list)) lost();
  };
  // Newest first; when the whole list does not fit, keep fewer of the newest until it does.
  const keepHistory = (list) => {
    lists[HISTORY] = list;
    if (!persistent) return;
    for (let n = list.length; ; n = Math.max(FLOOR, Math.floor(n / 2))) {
      if (write(HISTORY, list.slice(0, n))) {
        lists[HISTORY] = list.slice(0, n);
        return;
      }
      if (n <= FLOOR) break;
    }
    lost();
  };

  load(SETUPS);
  load(HISTORY);
  ready = true;

  const byNewest = (a, b) => String(b.at).localeCompare(String(a.at));
  const upsert = (list, item) => {
    const i = list.findIndex((x) => x.id === item.id);
    return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
  };

  return {
    get persistent() {
      return persistent;
    },
    async listSetups() {
      return structuredClone(load(SETUPS));
    },
    async saveSetup(setup) {
      keep(SETUPS, upsert(load(SETUPS), structuredClone(setup)));
    },
    async deleteSetup(id) {
      keep(SETUPS, load(SETUPS).filter((s) => s.id !== id));
    },
    async listHistory() {
      return structuredClone(load(HISTORY));
    },
    async saveEntry(entry) {
      keepHistory(upsert(load(HISTORY), structuredClone(entry)).sort(byNewest).slice(0, KEEP));
    },
    async deleteEntry(id) {
      keep(HISTORY, load(HISTORY).filter((e) => e.id !== id));
    },
    async clearHistory() {
      keep(HISTORY, []);
    },
  };
}
