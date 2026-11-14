import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from './limits.js';
import { addFiles, picturesLine, shortUrl, shrink, targetSize } from './pictures.js';
import { RunError } from './run-error.js';
import { dataUrlBytes, validateRun } from './systemone.js';

// A JPEG data URL of about `bytes` decoded bytes.
const jpeg = (bytes) => `data:image/jpeg;base64,/9j/${'A'.repeat(Math.max(0, Math.ceil(bytes / 3) - 1) * 4)}`;

// An encoder whose output grows with the pixels and the quality: `density` bytes per pixel at quality 1.
const encoder = (calls = []) => async (source, width, height, quality) => {
  calls.push({ width, height, quality });
  return jpeg(Math.round(width * height * quality * source.density));
};

const photo = (width = 4080, height = 3072, density = 0.25) => ({ width, height, density });
let n = 0;
const uid = () => `p${++n}`;
const opts = (extra = {}) => ({ edge: 768, encode: encoder(), uid, ...extra });

test('a phone photo is shrunk to the edge', () => {
  assert.deepEqual(targetSize(4080, 3072, 768), { width: 768, height: 578 });
});

test('a small picture is not enlarged', () => {
  assert.deepEqual(targetSize(640, 480, 768), { width: 640, height: 480 });
  assert.deepEqual(targetSize(768, 768, 768), { width: 768, height: 768 });
});

test('a portrait picture keeps its shape', () => {
  assert.deepEqual(targetSize(3072, 4080, 768), { width: 578, height: 768 });
  assert.deepEqual(targetSize(10000, 3, 768), { width: 768, height: 1 });
});

test('a shrunk picture says what it is', async () => {
  const p = await shrink(photo(), opts());
  assert.equal(p.width, 768);
  assert.equal(p.height, 578);
  assert.equal(p.bytes, dataUrlBytes(p.url));
  assert.ok(p.url.startsWith('data:image/jpeg;base64,/9j/'));
  assert.ok(p.preview.length <= LIMITS.previewChars);
  assert.match(p.id, /^p\d+$/);
  assert.equal(validateRun({ state: '', images: [p.url], questions: [{ key: 'q', type: 'noul', text: 'Q?' }] }), null);
});

test('the quality goes down until the picture fits', async () => {
  const calls = [];
  // 768×578 at 0.85 bytes per pixel: 377 KB at quality 0.85, 311 KB at 0.7, 222 KB at 0.5.
  const p = await shrink(photo(4080, 3072, 1), opts({ encode: encoder(calls) }));
  assert.deepEqual(calls.filter((c) => c.width === 768).map((c) => c.quality), [0.85, 0.7, 0.5]);
  assert.ok(p.bytes <= LIMITS.pictureBytes);
});

test('a picture that never fits is refused', async () => {
  await assert.rejects(shrink(photo(4080, 3072, 3), opts()), (e) => {
    assert.ok(e instanceof RunError);
    assert.equal(e.message, 'This picture is too large even after shrinking.');
    return true;
  });
});

test('the preview gets smaller until it fits its limit', async () => {
  const calls = [];
  // 96×72 at density 1: 4.1 KB at 0.6 (5,560 characters), 2.8 KB at 0.4 (3,700 characters).
  const p = await shrink(photo(4080, 3072, 1), opts({ encode: encoder(calls), edge: 256 }));
  assert.ok(p.preview.length <= LIMITS.previewChars);
  assert.deepEqual(calls.filter((c) => c.width === 96).map((c) => c.quality), [0.6, 0.4]);
});

test('a preview that never fits is left out', async () => {
  const encode = async (source, width) => jpeg(width > 96 ? 1000 : 5000);
  const p = await shrink(photo(), opts({ encode }));
  assert.equal(p.preview, null);
  assert.equal(p.bytes, dataUrlBytes(p.url));
});

const file = (name, source = photo()) => ({ name, source });
const decode = async (f) => {
  if (!f.source) throw new Error('not a picture');
  return f.source;
};
const adding = (extra = {}) => ({ max: 4, edge: 768, decode, encode: encoder(), uid, ...extra });

test('files are added in order after the ones already held', async () => {
  const held = [await shrink(photo(), opts())];
  const { pictures, problems } = await addFiles([file('a', photo(100, 50)), file('b', photo(50, 100))], held, adding());
  assert.deepEqual(problems, []);
  assert.equal(pictures[0], held[0]);
  assert.deepEqual(pictures.slice(1).map((p) => [p.width, p.height]), [[100, 50], [50, 100]]);
});

test('one unreadable file does not stop the others', async () => {
  const files = [file('a'), { name: 'notes.pdf' }, file('c'), { name: 'x.heic' }];
  const { pictures, problems } = await addFiles(files, [], adding());
  assert.equal(pictures.length, 2);
  assert.deepEqual(problems, ['This picture cannot be read. Try a JPEG or PNG.']);
});

test('files over the free slots are left out with one notice', async () => {
  const held = [];
  for (let i = 0; i < 3; i++) held.push(await shrink(photo(100, 100), opts()));
  const decoded = [];
  const counting = async (f) => {
    decoded.push(f.name);
    return decode(f);
  };
  const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => file(name, photo(100, 100)));
  const { pictures, problems } = await addFiles(files, held, adding({ decode: counting }));
  assert.equal(pictures.length, 4);
  assert.deepEqual(problems, ['Only 4 pictures fit. The others were left out.']);
  assert.deepEqual(decoded, ['a']);
});

test('nothing is added when the list is full', async () => {
  const held = [await shrink(photo(100, 100), opts())];
  const { pictures, problems } = await addFiles([file('a')], held, adding({ max: 1 }));
  assert.deepEqual(pictures, held);
  assert.deepEqual(problems, ['Only 1 picture fits. The others were left out.']);
});

test('the run budget is kept', async () => {
  // Each about 250 KB after shrinking: two fit into 600 KB, the third does not, a small fourth does.
  const big = () => file('big', photo(4080, 3072, 0.66));
  const { pictures, problems } = await addFiles([big(), big(), big(), file('small', photo(100, 100))], [], adding());
  assert.equal(pictures.length, 3);
  assert.ok(pictures.reduce((sum, p) => sum + p.bytes, 0) <= LIMITS.picturesBytes);
  assert.deepEqual(problems, ['These pictures are too large together. Remove one first.']);
});

test('a picture that is too large is reported and the rest are added', async () => {
  const { pictures, problems } = await addFiles([file('huge', photo(4080, 3072, 3)), file('ok')], [], adding());
  assert.equal(pictures.length, 1);
  assert.deepEqual(problems, ['This picture is too large even after shrinking.']);
});

test('the line under the pictures', () => {
  const p = (bytes, width = 768, height = 576) => ({ bytes, width, height });
  assert.equal(picturesLine([], 4), '');
  assert.equal(picturesLine([p(84 * 1024)], 4), '1 of 4 · 768×576 · 84 KB');
  assert.equal(picturesLine([p(84 * 1024), p(128 * 1024)], 4), '2 of 4 · 212 KB together');
  assert.equal(picturesLine([p(200)], 1), '1 of 1 · 768×576 · 1 KB');
});

test('a short url names the size', () => {
  assert.equal(shortUrl(jpeg(84 * 1024)), 'data:image/jpeg;base64,…(84 KB)');
  assert.equal(shortUrl('something else'), 'something else');
});
