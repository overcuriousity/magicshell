import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserStore } from './store-browser.js';

const memory = (seed = {}) => {
  const data = { ...seed };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

const setup = (id, name = id) => ({ id, name, questions: [{ key: 'q1', type: 'noul', text: '' }] });
const entry = (id, at, extra = {}) => ({
  id,
  at,
  guided: true,
  run: { state: '', questions: [{ key: 'q1', type: 'noul', text: 'Wet?' }] },
  reply: { answers: { q1: { type: 'noul', noul: 0.5 } } },
  totalMs: 1,
  ...extra,
});

test('browser store round trips setups and history', async () => {
  const storage = memory();
  const a = createBrowserStore(storage);
  await a.saveSetup(setup('s1', 'One'));
  await a.saveSetup(setup('s1', 'Uno'));
  await a.saveEntry(entry('e1', '2026-01-01T00:00:00Z'));
  await a.saveEntry(entry('e2', '2026-02-01T00:00:00Z'));
  const b = createBrowserStore(storage);
  assert.deepEqual(await b.listSetups(), [setup('s1', 'Uno')]);
  assert.deepEqual((await b.listHistory()).map((e) => e.id), ['e2', 'e1']);
  await b.deleteEntry('e2');
  await b.deleteSetup('s1');
  assert.equal((await b.listHistory()).length, 1);
  assert.equal((await b.listSetups()).length, 0);
  await b.clearHistory();
  assert.equal((await b.listHistory()).length, 0);
  assert.equal(b.persistent, true);
});

test('the 501st entry drops the oldest', async () => {
  const store = createBrowserStore(memory());
  for (let i = 0; i < 501; i += 1) await store.saveEntry(entry(`e${i}`, new Date(2026, 0, 1, 0, 0, i).toISOString()));
  const list = await store.listHistory();
  assert.equal(list.length, 500);
  assert.equal(list[0].id, 'e500');
  assert.ok(!list.some((e) => e.id === 'e0'));
});

test('damaged text and a list of the wrong shape both start empty', async () => {
  for (const bad of ['{not json', '42', '{"a":1}']) {
    const store = createBrowserStore(memory({ 'magicshell.setups': bad, 'magicshell.history': bad }));
    assert.deepEqual(await store.listSetups(), []);
    assert.deepEqual(await store.listHistory(), []);
    await store.saveSetup(setup('a'));
    assert.equal((await store.listSetups()).length, 1);
    assert.equal(store.persistent, true);
  }
});

test('junk items in the stored lists are left out and do not break saving', async () => {
  const storage = memory({
    'magicshell.setups': JSON.stringify([null, 7, { id: 1, name: 'x', questions: [] }, { id: 'x', name: 'X' }, setup('ok')]),
    'magicshell.history': JSON.stringify([null]),
  });
  const store = createBrowserStore(storage);
  assert.deepEqual((await store.listSetups()).map((s) => s.id), ['ok']);
  assert.deepEqual(await store.listHistory(), []);
  await store.saveEntry(entry('e1', '2026-01-01T00:00:00Z'));
  await store.saveSetup(setup('two'));
  assert.deepEqual((await store.listHistory()).map((e) => e.id), ['e1']);
  assert.deepEqual(JSON.parse(storage.data['magicshell.history']).map((e) => e.id), ['e1']);
  assert.equal(store.persistent, true);
});

test('a malformed history entry is left out', async () => {
  const malformed = [
    { id: 'a', at: '2026' },
    entry('b', '2026', { run: null }),
    entry('c', '2026', { reply: 'text' }),
    entry('d', '2026', { run: { state: '', questions: 'no' } }),
    entry('e', 5),
    entry('good', '2026-01-01T00:00:00Z'),
  ];
  const store = createBrowserStore(memory({ 'magicshell.history': JSON.stringify(malformed) }));
  assert.deepEqual((await store.listHistory()).map((e) => e.id), ['good']);
});

test('a full storage keeps working from memory and reports it once', async () => {
  let told = 0;
  const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const store = createBrowserStore(storage, { onNotSaving: () => (told += 1) });
  assert.equal(store.persistent, true);
  await store.saveSetup(setup('a'));
  assert.equal(store.persistent, false);
  await store.saveEntry(entry('e', '2026'));
  assert.equal((await store.listSetups()).length, 1);
  assert.equal((await store.listHistory()).length, 1);
  assert.equal(store.persistent, false);
  assert.equal(told, 1);
});

test('storage that fills up after boot is reported when it happens', async () => {
  let told = 0;
  let full = false;
  const storage = memory();
  const set = storage.setItem;
  storage.setItem = (k, v) => {
    if (full) throw new Error('QuotaExceededError');
    set(k, v);
  };
  const store = createBrowserStore(storage, { onNotSaving: () => (told += 1) });
  await store.saveSetup(setup('a'));
  assert.equal(told, 0);
  full = true;
  await store.saveSetup(setup('b'));
  assert.equal(store.persistent, false);
  assert.equal(told, 1);
  await store.saveSetup(setup('c'));
  assert.equal(told, 1);
  assert.deepEqual((await store.listSetups()).map((s) => s.id), ['a', 'b', 'c']);
});

test('a history that no longer fits drops its oldest entries until it does', async () => {
  let told = 0;
  const storage = memory();
  const set = storage.setItem;
  // Room for 20 entries.
  storage.setItem = (k, v) => {
    if (k === 'magicshell.history' && JSON.parse(v).length > 20) throw new Error('QuotaExceededError');
    set(k, v);
  };
  const store = createBrowserStore(storage, { onNotSaving: () => (told += 1) });
  for (let i = 0; i < 30; i += 1) await store.saveEntry(entry(`e${i}`, new Date(2026, 0, 1, 0, 0, i).toISOString()));
  const kept = JSON.parse(storage.data['magicshell.history']).map((e) => e.id);
  assert.ok(kept.length <= 20 && kept.length >= 10);
  assert.equal(kept[0], 'e29');
  assert.deepEqual((await store.listHistory()).map((e) => e.id), kept);
  assert.equal(store.persistent, true);
  assert.equal(told, 0);
});

test('a history that does not fit even at its floor is kept in memory and reported', async () => {
  let told = 0;
  const storage = memory();
  const set = storage.setItem;
  storage.setItem = (k, v) => {
    if (k === 'magicshell.history' && JSON.parse(v).length > 3) throw new Error('QuotaExceededError');
    set(k, v);
  };
  const store = createBrowserStore(storage, { onNotSaving: () => (told += 1) });
  for (let i = 0; i < 12; i += 1) await store.saveEntry(entry(`e${i}`, new Date(2026, 0, 1, 0, 0, i).toISOString()));
  assert.equal(store.persistent, false);
  assert.equal(told, 1);
  assert.equal((await store.listHistory()).length, 12);
});

test('two stores on one storage keep each other\'s writes', async () => {
  const storage = memory();
  const tab1 = createBrowserStore(storage);
  const tab2 = createBrowserStore(storage);
  await tab1.saveSetup(setup('one'));
  await tab2.saveSetup(setup('two'));
  await tab1.saveEntry(entry('e1', '2026-01-01T00:00:00Z'));
  await tab2.saveEntry(entry('e2', '2026-01-02T00:00:00Z'));
  await tab1.deleteSetup('nothing');
  assert.deepEqual((await tab1.listSetups()).map((s) => s.id), ['one', 'two']);
  assert.deepEqual((await tab2.listHistory()).map((e) => e.id), ['e2', 'e1']);
  await tab2.deleteEntry('e1');
  assert.deepEqual((await tab1.listHistory()).map((e) => e.id), ['e2']);
});

test('storage that cannot be read at all behaves the same', async () => {
  const boom = () => { throw new Error('denied'); };
  const store = createBrowserStore({ getItem: boom, setItem: boom });
  assert.equal(store.persistent, false);
  await store.saveSetup(setup('a'));
  assert.deepEqual(await store.listSetups(), [setup('a')]);
});
