import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserStore } from './store-browser.js';

const memory = (seed = {}) => {
  const data = { ...seed };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

test('browser store round trips setups and history', async () => {
  const storage = memory();
  const a = createBrowserStore(storage);
  await a.saveSetup({ id: 's1', name: 'One' });
  await a.saveSetup({ id: 's1', name: 'Uno' });
  await a.saveEntry({ id: 'e1', at: '2026-01-01T00:00:00Z' });
  await a.saveEntry({ id: 'e2', at: '2026-02-01T00:00:00Z' });
  const b = createBrowserStore(storage);
  assert.deepEqual(await b.listSetups(), [{ id: 's1', name: 'Uno' }]);
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
  for (let i = 0; i < 501; i += 1) await store.saveEntry({ id: `e${i}`, at: new Date(2026, 0, 1, 0, 0, i).toISOString() });
  const list = await store.listHistory();
  assert.equal(list.length, 500);
  assert.equal(list[0].id, 'e500');
  assert.ok(!list.some((e) => e.id === 'e0'));
});

test('corrupt stored data starts empty instead of failing', async () => {
  for (const bad of ['{not json', '42']) {
    const store = createBrowserStore(memory({ 'magicshell.setups': bad, 'magicshell.history': bad }));
    assert.deepEqual(await store.listSetups(), []);
    assert.deepEqual(await store.listHistory(), []);
    await store.saveSetup({ id: 'a' });
    assert.equal((await store.listSetups()).length, 1);
  }
});

test('a full storage keeps working from memory and reports it', async () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const store = createBrowserStore(storage);
  assert.equal(store.persistent, true);
  await store.saveSetup({ id: 'a' });
  assert.equal(store.persistent, false);
  await store.saveEntry({ id: 'e', at: '2026' });
  assert.equal((await store.listSetups()).length, 1);
  assert.equal((await store.listHistory()).length, 1);
  assert.equal(store.persistent, false);
});

test('storage that cannot be read at all behaves the same', async () => {
  const boom = () => { throw new Error('denied'); };
  const store = createBrowserStore({ getItem: boom, setItem: boom });
  assert.equal(store.persistent, false);
  await store.saveSetup({ id: 'a' });
  assert.deepEqual(await store.listSetups(), [{ id: 'a' }]);
});
