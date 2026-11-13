import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN } from './setups-builtin.js';
import { exportSetups, importSetups, validateSetup } from './transfer.js';

const counter = () => {
  let n = 0;
  return () => `id${++n}`;
};
const good = { name: 'Mine', sampleState: 'text', questions: [{ key: 'q1', type: 'noul', text: '' }] };

test('validateSetup checks name, sample state, then the questions', () => {
  assert.equal(validateSetup({ ...good, name: '  ' }), 'Name the setup.');
  assert.equal(validateSetup({ ...good, name: 'x'.repeat(61) }), 'Keep the setup name to 60 characters or fewer.');
  assert.equal(validateSetup({ ...good, sampleState: 'x'.repeat(8001) }), 'Shorten the situation to 8,000 characters or fewer.');
  assert.equal(validateSetup({ ...good, questions: [] }), 'Add at least one question.');
  assert.equal(validateSetup({ ...good, questions: [{ key: 'q1', type: 'noul', text: 'x'.repeat(501) }] }), 'Keep each question to 500 characters or fewer.');
  assert.equal(validateSetup(good), null);
});

test('exported setups import again unchanged apart from their ids', () => {
  const text = exportSetups(BUILTIN);
  assert.ok(!text.includes('builtin-'));
  assert.ok(!/"id"/.test(text));
  const { setups, skipped } = importSetups(text, counter());
  assert.equal(skipped, 0);
  assert.equal(setups.length, BUILTIN.length);
  const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'id' || k === 'builtin' ? undefined : x)));
  assert.deepEqual(strip(setups), strip(BUILTIN));
  assert.equal(new Set(setups.map((s) => s.id)).size, setups.length);
  assert.ok(setups[1].questions[0].options.every((o) => o.id.startsWith('id')));
});

test('an invalid setup in a file is skipped and counted', () => {
  const text = JSON.stringify({ magicshell: 2, setups: [good, { ...good, name: '' }, 7, { name: 'x', questions: 'no' }] });
  const { setups, skipped } = importSetups(text);
  assert.equal(setups.length, 1);
  assert.equal(skipped, 3);
  assert.match(setups[0].id, /^[0-9a-f-]{36}$/);
});

test('a file of another kind is refused', () => {
  for (const bad of ['{not json', '42', '[]', '{"magicshell":1,"setups":[]}', '{"magicshell":2}', 'null']) {
    assert.throws(() => importSetups(bad), { message: 'This file does not hold magicshell setups.' });
  }
});
