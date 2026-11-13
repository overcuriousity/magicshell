import assert from 'node:assert/strict';
import test from 'node:test';
import { detectMode } from './mode.js';

const reply = (status, text) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => text });
const NO_SERVER = { mode: null, model: null, user: null, version: null };

test('a missing server means no mode', async () => {
  const fetchFn = async () => {
    throw new TypeError('fetch failed');
  };
  assert.deepEqual(await detectMode(fetchFn), NO_SERVER);
});

test('an html 404 page means no mode', async () => {
  assert.deepEqual(await detectMode(reply(404, '<html>Not found</html>')), NO_SERVER);
  assert.deepEqual(await detectMode(reply(200, '<html>Hi</html>')), NO_SERVER);
  assert.deepEqual(await detectMode(reply(200, JSON.stringify({ mode: 'other' }))), NO_SERVER);
});

test('a server reports its mode', async () => {
  const body = JSON.stringify({ mode: 'accounts', model: 'm1', user: { username: 'ada' } });
  assert.deepEqual(await detectMode(reply(200, body)), { mode: 'accounts', model: 'm1', user: { username: 'ada' }, version: null });
  const open = JSON.stringify({ mode: 'open', model: 'm1', user: null, version: '2026.11.4' });
  assert.deepEqual(await detectMode(reply(200, open)), { mode: 'open', model: 'm1', user: null, version: '2026.11.4' });
});
