import assert from 'node:assert/strict';
import test from 'node:test';
import { addLabel, added, busyNote, carriesFiles, imageFiles, isFull, removed, sizeLabel } from './picture-field.js';

test('the button says Add another once a picture is held', () => {
  assert.equal(addLabel(0), 'Add picture');
  assert.equal(addLabel(1), 'Add another');
  assert.equal(addLabel(3), 'Add another');
});

test('the field is full at the server\'s maximum', () => {
  assert.equal(isFull([1, 2], 4), false);
  assert.equal(isFull([1, 2, 3, 4], 4), true);
  assert.equal(isFull([1], 1), true);
});

test('a paste or drop gives its image files only', () => {
  const png = { type: 'image/png', name: 'a.png' };
  const heic = { type: 'image/heic', name: 'b.heic' };
  const pdf = { type: 'application/pdf', name: 'c.pdf' };
  assert.deepEqual(imageFiles({ files: [png, pdf, heic] }), [png, heic]);
  assert.deepEqual(imageFiles({ files: [] }), []);
  assert.deepEqual(imageFiles({}), []);
  assert.deepEqual(imageFiles(null), []);
});

test('a paste with text only carries no files', () => {
  assert.equal(carriesFiles({ types: ['text/plain', 'text/html'] }), false);
  assert.equal(carriesFiles({ types: ['Files'] }), true);
  assert.equal(carriesFiles({ types: ['text/plain', 'Files'] }), true);
  assert.equal(carriesFiles(null), false);
});

test('adding and removing are said in a sentence', () => {
  assert.equal(added(1, 1), 'Picture 1 added.');
  assert.equal(added(1, 3), 'Picture 3 added.');
  assert.equal(added(2, 3), '2 pictures added.');
  assert.equal(added(0, 3), '');
  assert.equal(removed(2), 'Picture 2 removed.');
});

test('the note while the model reads pictures', () => {
  assert.equal(busyNote(0), '');
  assert.equal(busyNote(1), 'Reading the picture…');
  assert.equal(busyNote(3), 'Reading the pictures…');
});

test('a picture\'s size as History shows it', () => {
  assert.equal(sizeLabel({ width: 768, height: 576, bytes: 84 * 1024 }), '768×576 · 84 KB');
});
