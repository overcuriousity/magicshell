import assert from 'node:assert/strict';
import test from 'node:test';
import { nextItem, typeahead } from './menu.js';

const opts = ['Default', 'Compact', 'Dark', 'Light'];

test('type-ahead finds the next match after the current one and wraps', () => {
  assert.equal(typeahead(opts, 'd', 0), 2);
  assert.equal(typeahead(opts, 'd', 2), 0);
  assert.equal(typeahead(opts, 'co', -1), 1);
  assert.equal(typeahead(opts, 'x', 0), -1);
});

test('arrow keys stop at the ends, Home and End jump', () => {
  assert.equal(nextItem('ArrowDown', 3, 4), 3);
  assert.equal(nextItem('ArrowDown', 1, 4), 2);
  assert.equal(nextItem('ArrowUp', 0, 4), 0);
  assert.equal(nextItem('Home', 2, 4), 0);
  assert.equal(nextItem('End', 0, 4), 3);
  assert.equal(nextItem('x', 1, 4), null);
});
