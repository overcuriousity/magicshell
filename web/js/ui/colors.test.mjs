import assert from 'node:assert/strict';
import test from 'node:test';
import { levelClass, optionClass } from './colors.js';

test('options take the categorical slots by position', () => {
  assert.equal(optionClass(0), 'opt-1');
  assert.equal(optionClass(3), 'opt-4');
  assert.equal(optionClass(7), 'opt-8');
});

test('levels spread the four-step ramp over the scale', () => {
  assert.equal(levelClass(0, 10), 'lvl-1');
  assert.equal(levelClass(9, 10), 'lvl-4');
  assert.equal(levelClass(0, 2), 'lvl-1');
  assert.equal(levelClass(1, 2), 'lvl-4');
  assert.deepEqual([0, 1, 2, 3].map((i) => levelClass(i, 4)), ['lvl-1', 'lvl-2', 'lvl-3', 'lvl-4']);
  const ten = Array.from({ length: 10 }, (_, i) => Number(levelClass(i, 10).slice(4)));
  assert.ok(ten.every((v, i) => i === 0 || v >= ten[i - 1]), 'never steps back');
});
