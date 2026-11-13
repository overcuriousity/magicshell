import assert from 'node:assert/strict';
import test from 'node:test';

const { colorSlots } = await import('./bench-results.js');

const choice = (ids) => ({ type: 'choice', options: ids.map((id) => ({ id, name: id })) });
const score = (ids) => ({ type: 'score', levels: ids.map((id) => ({ id, text: id })) });

test('an option keeps its slot from A wherever B moved it', () => {
  assert.deepEqual(colorSlots(choice(['a', 'b', 'c']), choice(['c', 'a', 'b'])), [2, 0, 1]);
});

test('a new option in B takes a slot no option of A uses', () => {
  // B removed b and added x and y: x and y must not look like a or c.
  assert.deepEqual(colorSlots(choice(['a', 'b', 'c']), choice(['x', 'a', 'c', 'y'])), [3, 0, 2, 4]);
});

test('a new level in B takes its own position, within A\'s levels', () => {
  assert.deepEqual(colorSlots(score(['1', '2', '3']), score(['1', 'n', '2', '3', 'm'])), [0, 1, 1, 2, 2]);
});

test('no slots for a yes-or-no question or a missing A', () => {
  assert.equal(colorSlots({ type: 'noul' }, { type: 'noul' }), null);
  assert.equal(colorSlots(undefined, choice(['a'])), null);
});
