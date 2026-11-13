import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { checkOutcome, validateRun } from './systemone.js';

const dir = new URL('../../fixtures/systemone/', import.meta.url);
const load = (prefix) =>
  fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .map((n) => [n, JSON.parse(fs.readFileSync(new URL(n, dir), 'utf8'))]);

test('invalid fixtures give their sentence', () => {
  const all = load('invalid-');
  assert.ok(all.length >= 20);
  for (const [name, f] of all) assert.equal(validateRun(f.run), f.expected_error, name);
});

test('a valid run passes', () => {
  for (const [, f] of load('request-')) assert.equal(validateRun(f.run), null);
});

test('the outcome the server sends for a response fixture is read back unchanged', () => {
  const all = load('response-').filter(([, f]) => !f.expected.error);
  assert.ok(all.length >= 6);
  for (const [name, f] of all) {
    const out = checkOutcome(f.expected, f.run);
    // answers has no prototype; compare its entries as a plain object.
    assert.deepEqual({ ...out, answers: { ...out.answers } }, f.expected, name);
  }
});

test('a noul question ignores options and levels', () => {
  const run = { state: '', questions: [{ key: 'a', type: 'noul', text: 'Q', options: [], levels: [] }] };
  assert.equal(validateRun(run), null);
});

test('a question named __proto__ gets its own answer, not the prototype', () => {
  const run = { state: '', questions: [{ key: '__proto__', type: 'noul', text: 'Odd?' }, { key: 'constructor', type: 'noul', text: 'Odd too?' }] };
  assert.equal(validateRun(run), null);
  const reply = JSON.parse('{"answers":{"__proto__":{"type":"noul","noul":0.75},"constructor":{"type":"noul","noul":0.25}}}');
  const checked = checkOutcome(reply, run);
  assert.deepEqual(Object.keys(checked.answers), ['__proto__', 'constructor']);
  assert.equal(checked.answers.constructor.noul, 0.25);
  assert.equal(checked.answers.__proto__.noul, 0.75);
  assert.equal(JSON.parse(JSON.stringify(checked)).answers.__proto__.noul, 0.75);
  // An answer missing for such a key is not taken from the prototype.
  assert.throws(() => checkOutcome({ answers: {} }, run), { message: 'The model endpoint sent an answer this app does not understand.' });
});
