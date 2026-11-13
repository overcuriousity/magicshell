// Setups and history in localStorage. Each change reads the key again first, so two tabs keep each
// other's writes. Items of the wrong shape are left out when reading. When a write does not fit,
// History gives up as few of its oldest entries as make room (keeping at least FLOOR) and
// `onTrimmed(count)` says how many went. When storage fails even so, the data stays in memory for
// this page, `persistent` turns false and `onNotSaving` is called once.
import { RunError } from './run-error.js';
import { isObject } from './util.js';

const SETUPS = 'magicshell.setups';
const HISTORY = 'magicshell.history';
const KEEP = 500;
const FLOOR = 10;

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

export const TOO_OLD = 'History keeps only its 500 newest entries, and this one is older.';

// The largest n in [lo, hi] for which fits(n) holds, given that fewer always fit; null when lo does not.
function largest(lo, hi, fits) {
  if (!fits(lo)) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function createBrowserStore(storage, { onNotSaving = () => {}, onTrimmed = () => {} } = {}) {
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
  // Writes `list` under `key`. When it does not fit, the history (newest first) keeps the most of
  // its newest entries that leave room; the history in memory then matches what was stored.
  const keep = (key, list) => {
    lists[key] = list;
    if (!persistent || write(key, list)) return;
    const history = key === HISTORY ? list : lists[HISTORY];
    const floor = Math.min(FLOOR, history.length);
    let stored = false;
    const fits = (n) => {
      if (key === HISTORY) return write(HISTORY, history.slice(0, n));
      if (!write(HISTORY, history.slice(0, n))) return false;
      stored ||= write(key, list);
      return stored;
    };
    const n = history.length > floor ? largest(floor, history.length - 1, fits) : null;
    if (n === null) {
      lost();
      return;
    }
    lists[HISTORY] = history.slice(0, n);
    onTrimmed(history.length - n);
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
      const list = upsert(load(HISTORY), structuredClone(entry)).sort(byNewest);
      if (list.length > KEEP && list.slice(KEEP).some((e) => e.id === entry.id)) throw new RunError(TOO_OLD, 'validation');
      keep(HISTORY, list.slice(0, KEEP));
    },
    async deleteEntry(id) {
      keep(HISTORY, load(HISTORY).filter((e) => e.id !== id));
    },
    async clearHistory() {
      keep(HISTORY, []);
    },
  };
}
