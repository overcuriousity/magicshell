import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimilarService } from './similar-store.js';
import { withSuggestions } from './suggest-store.js';
import { memoryVectorStore } from './vector-store.js';

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

const similarDouble = () => {
  const updates = [];
  let options = null;
  const service = { update: (data) => updates.push(data) };
  return {
    updates,
    service,
    options: () => options,
    createService(args) { options = args; return service; },
  };
};

const similarOptions = (similar) => ({
  builtin: [{ id: 'builtin', name: 'Built in', questions: [] }],
  similar: { client: {}, config: { id: 'c', min: 0.75, owner: 'open' } },
  createService: similar.createService,
});

test('similar sources share the cached history and setups, including built-ins', async () => {
  const saved = { id: 'saved', name: 'Saved', questions: [] };
  const store = memoryStore({ history: [fire], setups: [saved] });
  const similar = similarDouble();
  const wrapped = withSuggestions(store, similarOptions(similar));
  assert.equal(wrapped.similar, similar.service);
  const expected = {
    history: [fire],
    setups: [{ id: 'builtin', name: 'Built in', questions: [] }, saved],
  };
  assert.deepEqual(await similar.options().sources(), expected);
  assert.deepEqual(await similar.options().sources(), expected);
  assert.equal(store.calls.listHistory, 1);
  assert.equal(store.calls.listSetups, 1);
});

test('an initial failed read preserves history and setup vectors until recovery', async () => {
  const history = [{
    id: 'dinner', at: '2026-11-12T10:00:00Z', run: { state: '', questions: [
      { key: 'q', type: 'choice', text: 'Dinner?', options: [{ name: 'pizza' }] },
    ] },
  }];
  const saved = { id: 'saved', name: 'Saved', questions: [
    { key: 'r', type: 'score', text: 'Rating?', levels: [{ text: 'Low' }, { text: 'High' }] },
  ] };
  const store = memoryStore({ history, setups: [saved] });
  store.failRead = 1;
  const vectors = memoryVectorStore();
  await vectors.claim('open');
  for (const questionKey of ['query?', 'dinner?', 'rating?']) {
    await vectors.put({ key: `c\0${questionKey}`, configId: 'c', questionKey, text: questionKey, vector: new Float32Array([1, 0]), refused: false });
  }
  let time = 0;
  let embeds = 0;
  const wrapped = withSuggestions(store, {
    builtin: [],
    now: () => time,
    similar: {
      client: { async embed() { embeds += 1; return [[1, 0]]; } },
      config: { id: 'c', min: 0.75, owner: 'open' },
    },
    createService(args) { return createSimilarService({ ...args, vectors }); },
  });
  await assert.doesNotReject(wrapped.similar.load('Query?'));
  assert.equal((await vectors.all()).length, 3);
  time = 30001;
  await wrapped.similar.load('Query?');
  assert.deepEqual(wrapped.similar.options('Query?'), ['pizza']);
  assert.deepEqual(wrapped.similar.scales('Query?'), [['Low', 'High']]);
  assert.equal((await vectors.all()).length, 3);
  assert.equal(embeds, 0);
});

test('successful history writes and their undo update similar sources without another read', async () => {
  const store = memoryStore();
  const similar = similarDouble();
  const wrapped = withSuggestions(store, similarOptions(similar));
  await wrapped.suggest.load();
  const other = entry('b', '2026-11-13T10:00:00Z', 'Scanner is on fire');
  await wrapped.saveEntry(fire);
  assert.deepEqual(similar.updates.at(-1).history, [fire]);
  await wrapped.saveEntry(other);
  assert.deepEqual(similar.updates.at(-1).history, [fire, other]);
  await wrapped.deleteEntry('a');
  assert.deepEqual(similar.updates.at(-1).history, [other]);
  await wrapped.saveEntry(fire);
  assert.deepEqual(similar.updates.at(-1).history, [other, fire]);
  await wrapped.clearHistory();
  assert.deepEqual(similar.updates.at(-1).history, []);
  await wrapped.saveEntry(fire);
  assert.deepEqual(similar.updates.at(-1).history, [fire]);
  assert.equal(store.calls.listHistory, 1);
  assert.equal(store.calls.listSetups, 1);
});

test('successful setup writes and their undo update similar sources with built-ins', async () => {
  const store = memoryStore();
  const similar = similarDouble();
  const wrapped = withSuggestions(store, similarOptions(similar));
  await wrapped.suggest.load();
  const saved = { id: 'saved', name: 'Saved', questions: [] };
  await wrapped.saveSetup(saved);
  assert.deepEqual(similar.updates.at(-1).setups, [
    { id: 'builtin', name: 'Built in', questions: [] }, saved,
  ]);
  await wrapped.deleteSetup(saved.id);
  assert.deepEqual(similar.updates.at(-1).setups, [{ id: 'builtin', name: 'Built in', questions: [] }]);
  await wrapped.saveSetup(saved);
  assert.deepEqual(similar.updates.at(-1).setups, [
    { id: 'builtin', name: 'Built in', questions: [] }, saved,
  ]);
});

test('a failed write does not update similar sources', async () => {
  const store = memoryStore();
  const similar = similarDouble();
  const wrapped = withSuggestions(store, similarOptions(similar));
  await wrapped.suggest.load();
  const count = similar.updates.length;
  assert.equal(count, 1);
  store.failWrite = true;
  await assert.rejects(wrapped.saveEntry(fire), /write failed/);
  assert.equal(similar.updates.length, count);
});

test('a refresh updates similar sources after the read succeeds', async () => {
  const store = memoryStore({ history: [fire] });
  const similar = similarDouble();
  const wrapped = withSuggestions(store, similarOptions(similar));
  await wrapped.suggest.load();
  await store.deleteEntry(fire.id);
  await wrapped.suggest.refresh();
  assert.deepEqual(similar.updates.at(-1).history, []);
});

test('similarity is off without a config', () => {
  const wrapped = withSuggestions(memoryStore());
  assert.equal(wrapped.similar, null);
});

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

test('a failed read offers nothing and is tried again after a while, not by every field', async () => {
  const store = memoryStore({ history: [fire] });
  store.failRead = 1;
  let t = 0;
  const wrapped = withSuggestions(store, { now: () => t });
  await wrapped.suggest.load();
  assert.equal(wrapped.suggest.current().rest('name', 'Ticket'), '');
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), '');
  t = 29_999;
  await Promise.all([wrapped.suggest.load(), wrapped.suggest.load()]);
  assert.equal(store.calls.listHistory, 1);
  t = 30_000;
  await wrapped.suggest.load();
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), 'nter is on fire');
  assert.equal(store.calls.listHistory, 2);
});

test('a cooldown load stays a thenable resolving false until the same retry time', async () => {
  const store = memoryStore({ history: [fire] });
  store.failRead = 1;
  let t = 0;
  const wrapped = withSuggestions(store, { now: () => t });
  assert.equal(await wrapped.suggest.load(), false);
  t = 29_999;
  const cooling = wrapped.suggest.load();
  assert.equal(typeof cooling.then, 'function');
  assert.equal(await cooling, false);
  assert.equal(store.calls.listHistory, 1);
  t = 30_000;
  assert.equal(await wrapped.suggest.load(), true);
  assert.equal(store.calls.listHistory, 2);
});

test('refresh reads again and keeps the old copy until then, or when it fails', async () => {
  const other = entry('b', '2026-11-12T11:00:00Z', 'Projector hums');
  const store = memoryStore({ history: [fire, other] });
  const wrapped = withSuggestions(store);
  await wrapped.suggest.load();
  // The store drops an entry by itself, as a browser store trims a full history.
  await store.deleteEntry('a');
  store.failRead = 1;
  await wrapped.suggest.refresh();
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), 'nter is on fire');
  const refreshing = wrapped.suggest.refresh();
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), 'nter is on fire');
  await refreshing;
  assert.equal(wrapped.suggest.current().rest('situation', 'Pri'), '');
  assert.equal(wrapped.suggest.current().rest('situation', 'Pro'), 'jector hums');
});

test('a write during a refresh is kept', async () => {
  const store = memoryStore({ history: [fire] });
  const wrapped = withSuggestions(store);
  await wrapped.suggest.load();
  const refreshing = wrapped.suggest.refresh();
  // Written after the read took its copy, so the read does not have it.
  await wrapped.saveEntry(entry('c', '2026-11-12T12:00:00Z', 'Kettle trips the fuse'));
  await refreshing;
  assert.equal(wrapped.suggest.current().rest('situation', 'Ket'), 'tle trips the fuse');
});

test("keeps the store's own properties", () => {
  const wrapped = withSuggestions({ persistent: true, listHistory: async () => [], listSetups: async () => [] });
  assert.equal(wrapped.persistent, true);
});

test("a getter on the store is read each time, as the browser store's persistent", () => {
  let persistent = true;
  const wrapped = withSuggestions({ get persistent() { return persistent; }, listHistory: async () => [], listSetups: async () => [] });
  assert.equal(wrapped.persistent, true);
  persistent = false;
  assert.equal(wrapped.persistent, false);
});
