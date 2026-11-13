// History's state and actions, without any DOM: the entries newest first, remove and clear with
// an undo, the headline of an entry and the time it is shown with.
import { requestText } from '../client-server.js';
import { nearestLevel, noulIsYes, scoreText } from '../format.js';
import { levelClass, optionClass } from '../ui/colors.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');

// "14:02" today, "12 Nov" this year, "12 Nov 2025" before; local time, fixed English months.
export function formatWhen(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

// The first question's text (the situation when the text is empty) and its answer as the pick,
// Yes or No, or for a score the nearest level (with the score for bench runs); `cls` is the colour.
export function headline(entry) {
  const q = entry?.run?.questions?.[0];
  const a = q ? entry.reply?.answers?.[q.key] : null;
  const text = (q?.text ?? '').trim() || (entry?.run?.state ?? '').trim() || q?.key || '';
  if (!q || !a) return { text, answer: '', cls: '' };
  if (a.type === 'choice') {
    const names = (q.options ?? []).map((o) => o.name.trim());
    const at = names.indexOf(String(a.choice ?? '').trim());
    // A pick that is not among the options gets the neutral tint, never another option's colour.
    return { text, answer: a.choice, cls: at >= 0 ? optionClass(at) : 'ms-neutral' };
  }
  if (a.type === 'score') {
    const levels = (q.levels ?? []).map((l) => l.text.trim());
    const nearest = nearestLevel(a.score, levels.length);
    const level = levels[nearest] ?? '';
    return { text, answer: entry.guided ? level : `${scoreText(a.score)} · ${level}`, cls: levelClass(nearest, levels.length) };
  }
  return { text, answer: noulIsYes(a.noul) ? 'Yes' : 'No', cls: 'ms-accent' };
}

// The result of an entry in the shape the bench keeps for a run. Entries do not keep the request
// (it is the run), so it is written out again as the server client sends it.
export const benchResult = (entry) => ({
  ...entry.reply,
  request: requestText(entry.run),
  totalMs: entry.totalMs,
});

export function createHistoryModel(store) {
  let list = [];
  const listeners = new Set();
  const emit = () => {
    for (const fn of listeners) fn(list);
  };

  const model = {
    async load() {
      list = await store.listHistory();
      emit();
    },
    entries: () => list,
    find: (id) => list.find((e) => e.id === id) ?? null,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // The part Why? kept, on the entry in the list and in the store. Quiet: the open entry screen
    // keeps its panel and must not be rebuilt under it.
    async saveWhy(id, why) {
      const entry = model.find(id);
      if (!entry) return;
      entry.why = why;
      await store.saveEntry(entry);
    },
    // Both resolve to an undo that saves the removed entries back.
    async remove(id) {
      const before = list;
      const gone = list.filter((e) => e.id === id);
      // Out of the list first: a Why? save still on its way finds no entry and does not put it back.
      list = list.filter((e) => e.id !== id);
      try {
        for (const e of gone) await store.deleteEntry(e.id);
      } catch (e) {
        list = before;
        throw e;
      }
      await model.load();
      return restorer(gone);
    },
    async clear() {
      const before = list;
      const gone = list.slice();
      list = [];
      try {
        await store.clearHistory();
      } catch (e) {
        list = before;
        throw e;
      }
      await model.load();
      return restorer(gone);
    },
  };

  const restorer = (gone) => async () => {
    for (const e of gone.slice().reverse()) await store.saveEntry(e);
    await model.load();
  };
  return model;
}
