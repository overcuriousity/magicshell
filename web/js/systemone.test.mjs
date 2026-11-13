import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { checkOutcome, parseResponse, requestJson, validateRun } from './systemone.js';

const dir = new URL('../../fixtures/systemone/', import.meta.url);
const load = (prefix) =>
  fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .map((n) => [n, JSON.parse(fs.readFileSync(new URL(n, dir), 'utf8'))]);

test('request fixtures build the exact request body', () => {
  const all = load('request-');
  assert.ok(all.length >= 6);
  for (const [name, f] of all) assert.equal(requestJson(f.run, f.model), f.expected_json, name);
});

test('response fixtures parse to the expected outcome or error', () => {
  const all = load('response-');
  assert.ok(all.length >= 11);
  for (const [name, f] of all) {
    if (f.expected.error) {
      assert.throws(() => parseResponse(f.body, f.run), { message: f.expected.error }, name);
    } else {
      const out = parseResponse(f.body, f.run);
      // answers has no prototype; compare its entries as a plain object.
      assert.deepEqual({ ...out, answers: { ...out.answers } }, f.expected, name);
    }
  }
});

test('invalid fixtures give their sentence', () => {
  const all = load('invalid-');
  assert.ok(all.length >= 20);
  for (const [name, f] of all) assert.equal(validateRun(f.run), f.expected_error, name);
});

test('a valid run passes', () => {
  for (const [, f] of load('request-')) assert.equal(validateRun(f.run), null);
});

test('integer-like option names keep their order', () => {
  const [, f] = load('request-choice-numeric-names')[0];
  const out = requestJson(f.run, f.model);
  assert.ok(out.indexOf('"10"') < out.indexOf('"2"'));
  assert.ok(out.indexOf('"2"') < out.indexOf('"1"'));
});

test('names, descriptions, levels and question text are trimmed', () => {
  const run = {
    state: ' keep ',
    questions: [
      { key: 'a', type: 'choice', text: ' Q ', options: [
        { id: '1', name: ' x ', description: ' dx ' },
        { id: '2', name: 'y', description: '  ' }] },
      { key: 'b', type: 'score', text: 'S', levels: [{ id: '1', text: ' lo ' }, { id: '2', text: 'hi' }] },
    ],
  };
  assert.equal(
    requestJson(run, 'm'),
    '{"model":"m","state":" keep ","questions":{"a":{"type":"choice","instructions":"Q","criteria":{"x":"dx","y":"y"}},"b":{"type":"score","instructions":"S","criteria":["lo","hi"]}}}',
  );
});

test('a noul question ignores options and levels', () => {
  const run = { state: '', questions: [{ key: 'a', type: 'noul', text: 'Q', options: [], levels: [] }] };
  assert.equal(validateRun(run), null);
  assert.equal(requestJson(run, 'm'), '{"model":"m","state":"","questions":{"a":{"type":"noul","instructions":"Q"}}}');
});

test('a question named __proto__ gets its own answer, not the prototype', () => {
  const run = { state: '', questions: [{ key: '__proto__', type: 'noul', text: 'Odd?' }, { key: 'constructor', type: 'noul', text: 'Odd too?' }] };
  assert.equal(validateRun(run), null);
  const body = JSON.parse('{"answers":{"__proto__":{"type":"noul","noul":0.75},"constructor":{"type":"noul","noul":0.25}}}');
  const parsed = parseResponse(body, run);
  assert.deepEqual(Object.keys(parsed.answers), ['__proto__', 'constructor']);
  assert.equal(parsed.answers.__proto__.noul, 0.75);
  assert.equal(parsed.answers.constructor.noul, 0.25);
  const reply = JSON.parse('{"answers":{"__proto__":{"type":"noul","noul":0.75},"constructor":{"type":"noul","noul":0.25}}}');
  const checked = checkOutcome(reply, run);
  assert.equal(checked.answers.__proto__.noul, 0.75);
  assert.equal(JSON.parse(JSON.stringify(checked)).answers.__proto__.noul, 0.75);
  // An answer missing for such a key is not taken from the prototype.
  assert.throws(() => checkOutcome({ answers: {} }, run), { message: 'The model endpoint sent an answer this app does not understand.' });
});
