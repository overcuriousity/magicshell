import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerStore } from './store-server.js';

const reply = (status, text = '') => ({ status, ok: status >= 200 && status < 300, text: async () => text });
const recorder = (answer) => {
  const seen = [];
  return { seen, fetch: async (url, init) => (seen.push({ url, init }), answer(url, init)) };
};

test('the server store maps each method to its route', async () => {
  const { seen, fetch } = recorder((url, init) =>
    init.method === 'GET' ? reply(200, '[{"id":"x"}]') : reply(204));
  const store = createServerStore(fetch);
  assert.equal(store.persistent, true);
  assert.deepEqual(await store.listSetups(), [{ id: 'x' }]);
  await store.saveSetup({ id: 's1', name: 'n' });
  await store.deleteSetup('s1');
  assert.deepEqual(await store.listHistory(), [{ id: 'x' }]);
  await store.saveEntry({ id: 'e1', at: 'a' });
  await store.deleteEntry('e1');
  await store.clearHistory();
  assert.deepEqual(
    seen.map((s) => `${s.init.method} ${s.url}`),
    ['GET api/setups', 'PUT api/setups/s1', 'DELETE api/setups/s1', 'GET api/history',
      'PUT api/history/e1', 'DELETE api/history/e1', 'DELETE api/history'],
  );
  assert.equal(seen[1].init.body, '{"id":"s1","name":"n"}');
  assert.equal(seen[1].init.headers['Content-Type'], 'application/json');
});

test('errors become RunErrors with the server sentence', async () => {
  const cases = [[401, 'Sign in first.', 'auth'], [422, 'Name the setup.', 'validation'], [500, '', 'upstream']];
  for (const [status, text, kind] of cases) {
    const store = createServerStore(async () => reply(status, text));
    await assert.rejects(store.saveSetup({ id: 'a' }), (e) => {
      assert.equal(e.name, 'RunError');
      assert.equal(e.kind, kind);
      assert.ok(text === '' ? e.message.includes('500') : e.message === text);
      return true;
    });
  }
  const down = createServerStore(async () => { throw new Error('x'); });
  await assert.rejects(down.listSetups(), (e) => e.kind === 'network');
});
