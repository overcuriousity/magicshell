import assert from 'node:assert/strict';
import test from 'node:test';
import { withSuggestions } from './suggest-store.js';

const entry = (id, at, state, question = 'Which printer?') => ({
  id,
  at,
  run: { state, questions: [{ key: 'q1', type: 'noul', text: question }] },
});

// A store like the real ones, with call counters and switches to make reads and writes fail.
const memoryStore = ({ history = [], setups = [] } = {}) => {
  let hist = [...history];
  let sets = [...setups];
  const store = {
    persistent: true,
    calls: { listHistory: 0, listSetups: 0 },
    failRead: 0,
    failWrite: false,
    async listHistory() {
      store.calls.listHistory += 1;
      if (store.failRead > 0) { store.failRead -= 1; throw new Error('read failed'); }
      return [...hist];
    },
    async listSetups() { store.calls.listSetups += 1; return [...sets]; },
    async saveEntry(e) { if (store.failWrite) throw new Error('write failed'); hist = [...hist.filter((x) => x.id !== e.id), e]; },
    async deleteEntry(id) { hist = hist.filter((e) => e.id !== id); },
    async clearHistory() { hist = []; },
    async saveSetup(s) { sets = [...sets.filter((x) => x.id !== s.id), s]; },
    async deleteSetup(id) { sets = sets.filter((s) => s.id !== id); },
  };
  return store;
};

const fire = entry('a', '2026-11-12T10:00:00Z', 'Printer is on fire');

test('reads history and setups once, however often load is called', async () => {
  const store = memoryStore();
  const wrapped = withSuggestions(store);
  await Promise.all([wrapped.suggest.load(), wrapped.suggest.load()]);
  await wrapped.suggest.load();
  assert.equal(store.calls.listHistory, 1);
  assert.equal(store.calls.listSetups, 1);
});

test('offers nothing before the read and built-ins after it', async () => {
  const wrapped = withSuggestions(memoryStore());
  assert.equal(wrapped.suggest.current().rest('question', 'Which'), '');
  assert.equal(wrapped.suggest.current().rest('name', 'Ticket'), '');
  await wrapped.suggest.load();
  assert.equal(wrapped.suggest.current().rest('name', 'Ticket'), ' triage');
});

test('a saved run is suggested without a second read', async () => {
  const store = memoryStore();
  const wrapped = withSuggestions(store);
  await wrapped.suggest.load();
  await wrapped.saveEntry(fire);
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), 'nter is on fire');
  assert.equal(store.calls.listHistory, 1);
});

test('a saved entry with the same id replaces the old one', async () => {
  const wrapped = withSuggestions(memoryStore({ history: [fire] }));
  await wrapped.suggest.load();
  await wrapped.saveEntry(entry('a', '2026-11-13T10:00:00Z', 'Scanner is on fire'));
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), '');
  assert.equal(wrapped.suggest.current().rest('situation', 'Sca'), 'nner is on fire');
});

test('a deleted entry is no longer suggested', async () => {
  const wrapped = withSuggestions(memoryStore({ history: [fire] }));
  await wrapped.suggest.load();
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), 'nter is on fire');
  await wrapped.deleteEntry('a');
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), '');
});

test('a cleared history is no longer suggested', async () => {
  const wrapped = withSuggestions(memoryStore({ history: [fire] }));
  await wrapped.suggest.load();
  assert.deepEqual(wrapped.suggest.current().recent('question'), ['Which printer?']);
  await wrapped.clearHistory();
  assert.deepEqual(wrapped.suggest.current().recent('question'), []);
});

test('a saved setup changes the name pool', async () => {
  const wrapped = withSuggestions(memoryStore());
  await wrapped.suggest.load();
  await wrapped.saveSetup({ id: 's1', name: 'Quarterly review', questions: [] });
  assert.equal(wrapped.suggest.current().rest('name', 'Quar'), 'terly review');
});

test('a deleted setup leaves the name pool', async () => {
  const wrapped = withSuggestions(memoryStore({ setups: [{ id: 's1', name: 'Quarterly review', questions: [] }] }));
  await wrapped.suggest.load();
  assert.equal(wrapped.suggest.current().rest('name', 'Quar'), 'terly review');
  await wrapped.deleteSetup('s1');
  assert.equal(wrapped.suggest.current().rest('name', 'Quar'), '');
});

test('a write that fails changes nothing and still rejects', async () => {
  const store = memoryStore();
  const wrapped = withSuggestions(store);
  await wrapped.suggest.load();
  store.failWrite = true;
  await assert.rejects(wrapped.saveEntry(fire), /write failed/);
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), '');
});

test('a write that lands before the read finishes is not lost', async () => {
  const store = memoryStore();
  const wrapped = withSuggestions(store);
  const loading = wrapped.suggest.load();
  await wrapped.saveEntry(fire);
  await loading;
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), 'nter is on fire');
});

test('a failed read offers nothing and is tried again', async () => {
  const store = memoryStore({ history: [fire] });
  store.failRead = 1;
  const wrapped = withSuggestions(store);
  await wrapped.suggest.load();
  assert.equal(wrapped.suggest.current().rest('name', 'Ticket'), '');
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), '');
  await wrapped.suggest.load();
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), 'nter is on fire');
  assert.equal(store.calls.listHistory, 2);
});

test("keeps the store's own properties", () => {
  const wrapped = withSuggestions({ persistent: true, listHistory: async () => [], listSetups: async () => [] });
  assert.equal(wrapped.persistent, true);
});
