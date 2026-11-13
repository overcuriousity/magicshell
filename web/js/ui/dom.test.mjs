import assert from 'node:assert/strict';
import test from 'node:test';
import { present } from './dom.js';

test('present drops null, undefined and false, which a browser would write out as text', () => {
  const a = { n: 1 };
  assert.deepEqual(present([null, a, undefined, false, 'text']), [a, 'text']);
});
