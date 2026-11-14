import assert from 'node:assert/strict';
import test from 'node:test';
import { caretOf, present, restoreCaret } from './dom.js';

test('present drops null, undefined and false, which a browser would write out as text', () => {
  const a = { n: 1 };
  assert.deepEqual(present([null, a, undefined, false, 'text']), [a, 'text']);
});

test('the caret of a text field is read and put back on the field that replaces it', () => {
  const old = { selectionStart: 3, selectionEnd: 7, scrollTop: 40 };
  const caret = caretOf(old);
  assert.deepEqual(caret, { start: 3, end: 7, scroll: 40 });
  const calls = [];
  const fresh = { value: 'An uploaded image.', scrollTop: 0, setSelectionRange: (a, b) => calls.push([a, b]) };
  restoreCaret(fresh, caret);
  assert.deepEqual(calls, [[3, 7]]);
  assert.equal(fresh.scrollTop, 40);
});

test('what has no caret is left alone', () => {
  assert.equal(caretOf(null), null);
  assert.equal(caretOf({ tagName: 'BUTTON' }), null);
  // A checkbox or a file input throws on selectionStart in some browsers and has null in others.
  assert.equal(caretOf({ get selectionStart() { throw new Error('no selection'); } }), null);
  assert.equal(caretOf({ selectionStart: null, selectionEnd: null }), null);
  restoreCaret(null, { start: 1, end: 1, scroll: 0 });
  restoreCaret({ setSelectionRange() { throw new Error('not a text field'); } }, { start: 1, end: 1, scroll: 0 });
  restoreCaret({ setSelectionRange() { throw new Error('unused'); } }, null);
});
