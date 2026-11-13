import assert from 'node:assert/strict';
import test from 'node:test';
import { route } from './app.js';

test('an empty hash opens Ask', () => {
  assert.deepEqual(route(''), { view: 'ask' });
  assert.deepEqual(route('#'), { view: 'ask' });
  assert.deepEqual(route('#/'), { view: 'ask' });
});

test('each destination has its own route', () => {
  for (const view of ['ask', 'history', 'setups', 'settings', 'sign-in']) {
    assert.deepEqual(route(`#/${view}`), { view });
  }
});

test('a second segment is the id', () => {
  assert.deepEqual(route('#/history/abc'), { view: 'history', id: 'abc' });
  assert.deepEqual(route('#/setups/my%20setup'), { view: 'setups', id: 'my setup' });
});

test('an unknown route opens Ask', () => {
  assert.deepEqual(route('#/nope'), { view: 'ask' });
  assert.deepEqual(route('#/nope/abc'), { view: 'ask' });
  assert.deepEqual(route('history'), { view: 'ask' });
});
