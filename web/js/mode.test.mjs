import assert from 'node:assert/strict';
import test from 'node:test';
import { detectMode, normaliseEndpoint } from './mode.js';

const reply = (status, text) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => text });
const PAGES = { mode: 'pages', model: null, user: null };

test('a missing server means pages mode', async () => {
  const fetchFn = async () => {
    throw new TypeError('fetch failed');
  };
  assert.deepEqual(await detectMode(fetchFn), PAGES);
});

test('an html 404 page means pages mode', async () => {
  assert.deepEqual(await detectMode(reply(404, '<html>Not found</html>')), PAGES);
  assert.deepEqual(await detectMode(reply(200, '<html>Hi</html>')), PAGES);
});

test('a server reports its mode', async () => {
  const body = JSON.stringify({ mode: 'accounts', model: 'm1', user: { username: 'ada' } });
  assert.deepEqual(await detectMode(reply(200, body)), { mode: 'accounts', model: 'm1', user: { username: 'ada' } });
  const open = JSON.stringify({ mode: 'open', model: 'm1', user: null });
  assert.deepEqual(await detectMode(reply(200, open)), { mode: 'open', model: 'm1', user: null });
});

test('endpoints are normalised and checked', () => {
  assert.deepEqual(normaliseEndpoint('https://h/v1/'), { url: 'https://h/v1' });
  assert.deepEqual(normaliseEndpoint(' https://h/v1/systemone '), { url: 'https://h/v1' });
  assert.deepEqual(normaliseEndpoint('http://localhost:8080/v1'), { url: 'http://localhost:8080/v1' });
  assert.deepEqual(normaliseEndpoint('http://127.0.0.1:9/v1'), { url: 'http://127.0.0.1:9/v1' });
  const error = 'Use an https address, or http://localhost for a model on this machine.';
  assert.deepEqual(normaliseEndpoint('http://example.org'), { error });
  assert.deepEqual(normaliseEndpoint('h/v1'), { error });
  assert.deepEqual(normaliseEndpoint(''), { error });
});
