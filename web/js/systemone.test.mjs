import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseResponse, requestJson, validateRun } from './systemone.js';

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
      assert.deepEqual(parseResponse(f.body, f.run), f.expected, name);
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
