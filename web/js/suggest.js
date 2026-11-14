// Pools of past values (history, setups, scales) and the matching behind the grey suggestion.
export const POOLS = ['question', 'situation', 'option', 'description', 'level', 'key', 'name'];

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : []);
const time = (v) => (typeof v === 'string' ? v : '');

function add(pool, raw, at, fromHistory, name = '') {
  const t = text(raw);
  if (!t) return;
  const lower = t.toLowerCase();
  let e = pool.get(lower);
  if (!e) {
    e = { text: t, lower, count: 0, historyCount: 0, last: '', fromHistory: false, names: new Set() };
    pool.set(lower, e);
  }
  e.count += 1;
  // The latest use decides the spelling; on a tie the later one read wins.
  if (at >= e.last) {
    e.last = at;
    e.text = t;
  }
  if (fromHistory) {
    e.fromHistory = true;
    e.historyCount += 1;
  }
  if (name) e.names.add(name.toLowerCase());
}

function addQuestions(pools, questions, at, fromHistory) {
  for (const q of list(questions)) {
    if (!q || typeof q !== 'object') continue;
    add(pools.question, q.text, at, fromHistory);
    add(pools.key, q.key, at, fromHistory);
    for (const o of list(q.options)) {
      if (!o || typeof o !== 'object') continue;
      add(pools.option, o.name, at, fromHistory);
      add(pools.description, o.description, at, fromHistory, text(o.name));
    }
    for (const l of list(q.levels)) {
      if (l && typeof l === 'object') add(pools.level, l.text, at, fromHistory);
    }
  }
}

// Latest last-used wins; then more uses, then shorter, then code-unit order.
function better(a, b) {
  if (a.last !== b.last) return a.last > b.last;
  if (a.count !== b.count) return a.count > b.count;
  if (a.text.length !== b.text.length) return a.text.length < b.text.length;
  return a.text < b.text;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

function cut(rest, room) {
  if (room >= rest.length) return rest;
  if (room <= 0) return '';
  let end = room;
  if (isHigh(rest.charCodeAt(end - 1)) && isLow(rest.charCodeAt(end))) end -= 1;
  return rest.slice(0, end);
}

export function createSuggestions({ history = [], setups = [], scales = [] } = {}) {
  const pools = Object.fromEntries(POOLS.map((p) => [p, new Map()]));
  for (const h of list(history)) {
    if (!h || typeof h !== 'object' || !h.run || typeof h.run !== 'object') continue;
    const at = time(h.at);
    add(pools.situation, h.run.state, at, true);
    addQuestions(pools, h.run.questions, at, true);
  }
  for (const s of list(setups)) {
    if (!s || typeof s !== 'object') continue;
    add(pools.name, s.name, '', false);
    add(pools.situation, s.sampleState, '', false);
    addQuestions(pools, s.questions, '', false);
  }
  for (const sc of list(scales)) {
    if (!sc || typeof sc !== 'object') continue;
    for (const l of list(sc.levels)) add(pools.level, l, '', false);
  }

  const history_ = (pool) => (pools[pool] ? [...pools[pool].values()].filter((e) => e.fromHistory) : []);

  return {
    rest(pool, typed, { limit = Infinity, pairedName = '' } = {}) {
      const values = pools[pool];
      if (!values || typeof typed !== 'string' || typed.length === 0) return '';
      const t = typed.toLowerCase();
      const paired = text(pairedName).toLowerCase();
      let best = null;
      let bestPaired = false;
      for (const e of values.values()) {
        if (e.lower.length <= t.length || !e.lower.startsWith(t)) continue;
        const p = pool === 'description' && paired !== '' && e.names.has(paired);
        if (best === null || (p && !bestPaired) || (p === bestPaired && better(e, best))) {
          best = e;
          bestPaired = p;
        }
      }
      if (!best) return '';
      return cut(best.text.slice(typed.length), limit - typed.length);
    },
    recent(pool, n = 5) {
      return history_(pool)
        .sort((a, b) => (a.last === b.last ? 0 : a.last > b.last ? -1 : 1))
        .slice(0, n)
        .map((e) => e.text);
    },
    frequent(pool, n = 5, exclude = []) {
      const skip = new Set(exclude.map((x) => String(x).toLowerCase()));
      return history_(pool)
        .filter((e) => !skip.has(e.lower))
        .sort((a, b) => b.historyCount - a.historyCount || (a.last === b.last ? 0 : a.last > b.last ? -1 : 1))
        .slice(0, n)
        .map((e) => e.text);
    },
  };
}

export const EMPTY = createSuggestions({});

export function nextWord(rest) {
  const m = /^\s*\S+/.exec(rest);
  return m ? m[0] : rest;
}
