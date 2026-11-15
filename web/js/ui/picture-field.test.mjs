import assert from 'node:assert/strict';
import test from 'node:test';
import { addLabel, added, busyNote, carriesFiles, createPictureField, guardStrayDrops, imageFiles, isFull, pastedPictures, removed, sizeLabel } from './picture-field.js';

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

test('a paste with text beside a picture is left alone', () => {
  const png = { type: 'image/png', name: 'cells.png' };
  // What a spreadsheet puts on the clipboard: the cells as text and as a rendering.
  assert.deepEqual(pastedPictures({ types: ['text/plain', 'text/html', 'Files'], files: [png] }), []);
  assert.deepEqual(pastedPictures({ types: ['Files'], files: [png] }), [png]);
  assert.deepEqual(pastedPictures({ types: ['text/html', 'Files'], files: [png] }), [png]);
  assert.deepEqual(pastedPictures({ types: ['text/plain'], files: [] }), []);
  assert.deepEqual(pastedPictures(null), []);
});

// The control's adding, with a codec that shrinks when the test lets it.
function field({ max = 4 } = {}) {
  let held = [];
  const notices = [];
  const said = [];
  const gates = [];
  const codec = {
    decode: (file) =>
      new Promise((resolve, reject) => {
        gates.push(() => (file.bad ? reject(new Error('not a picture')) : resolve({ width: 100, height: 80, name: file.name })));
      }),
    encode: async (source, width) => `data:image/jpeg;base64,/9j/${'A'.repeat(width > 96 ? 400 : 40)}`,
  };
  const f = createPictureField({
    id: 't',
    get: () => held,
    set: (list) => { held = list; },
    limits: { max, edge: 768 },
    notify: (text) => notices.push(text),
    announce: (text) => said.push(text),
    codec,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // Lets the next waiting decode go on, then lets what follows from it happen.
  const release = async () => {
    await tick();
    gates.shift()();
    await tick();
  };
  return { f, notices, said, gates, release, held: () => held, drop: (i) => { held = held.filter((_, j) => j !== i); } };
}
const img = (name, bad = false) => ({ name, type: 'image/png', bad });

test('problems are notified once each', async () => {
  const t = field();
  const done = t.f.add([img('a', true), img('b'), img('c', true)]);
  for (let i = 0; i < 3; i++) await t.release();
  await done;
  assert.equal(t.held().length, 1);
  assert.deepEqual(t.notices, ['This picture cannot be read. Try a JPEG or PNG.']);
  assert.deepEqual(t.said, ['Picture 1 added.']);
});

test('a second add while the first is still shrinking is not lost', async () => {
  const t = field();
  const first = t.f.add([img('a')]);
  const second = t.f.add([img('b')]);
  await t.release();
  await t.release();
  await Promise.all([first, second]);
  assert.equal(t.held().length, 2);
  assert.deepEqual(t.said, ['Picture 1 added.', 'Picture 2 added.']);
});

test('a picture removed while another is shrinking stays removed', async () => {
  const t = field();
  const first = t.f.add([img('a')]);
  await t.release();
  await first;
  const keep = t.held()[0].id;
  const second = t.f.add([img('b')]);
  await new Promise((r) => setTimeout(r, 0));
  t.drop(0);
  await t.release();
  await second;
  assert.equal(t.held().length, 1);
  assert.notEqual(t.held()[0].id, keep);
});

test('adds that queue up never go over the maximum', async () => {
  const t = field({ max: 2 });
  const adds = [t.f.add([img('a')]), t.f.add([img('b')]), t.f.add([img('c')])];
  await t.release();
  await t.release();
  await Promise.all(adds);
  assert.equal(t.held().length, 2);
  assert.deepEqual(t.notices, ['Only 2 pictures fit. The others were left out.']);
});

test('a file dropped beside the situation does not open in place of the app', () => {
  const listeners = {};
  guardStrayDrops({ addEventListener: (type, fn) => { listeners[type] = fn; } });
  const event = (types) => {
    const e = { dataTransfer: { types }, prevented: false, preventDefault() { e.prevented = true; } };
    return e;
  };
  for (const type of ['dragover', 'drop']) {
    const files = event(['Files']);
    listeners[type](files);
    assert.equal(files.prevented, true, type);
    const text = event(['text/plain']);
    listeners[type](text);
    assert.equal(text.prevented, false, type);
  }
});

test('a camera button opens a capture input; the picker input takes several files', () => {
  const node = (tag) => ({
    tagName: tag, attrs: {}, kids: [], listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, fn) { this.listeners[t] = fn; },
    append(...n) { this.kids.push(...n); },
  });
  const saved = globalThis.document;
  globalThis.document = { createElement: node, createElementNS: (_ns, tag) => node(tag), createTextNode: (t) => ({ text: t }) };
  try {
    const el = field().f.element();
    const all = (n, out = []) => { if (n?.tagName) { out.push(n); n.kids.forEach((k) => all(k, out)); } return out; };
    const inputs = all(el).filter((n) => n.tagName === 'input');
    assert.deepEqual(inputs.map((i) => [i.attrs.capture ?? null, i.attrs.multiple ?? null]), [[null, ''], ['environment', null]]);
    const camera = all(el).find((n) => n.attrs['data-fid'] === 't:camera');
    assert.ok(camera.attrs.class.includes('ms-pictures__camera'));
  } finally {
    globalThis.document = saved;
  }
});
