import assert from 'node:assert/strict';
import test from 'node:test';
import { prettyJson } from './json-text.js';

test('json is indented by two spaces', () => {
  assert.equal(prettyJson('{"a":1,"b":[1,2],"c":{}}'), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {}\n}');
});

test('keys keep their order, even integer-like ones', () => {
  assert.equal(prettyJson('{"10":"x","2":"y","1":"z"}'), '{\n  "10": "x",\n  "2": "y",\n  "1": "z"\n}');
});

test('strings with brackets, commas and escapes stay as they are', () => {
  assert.equal(prettyJson('{"s":"a, {b} [c] \\"d\\": e"}'), '{\n  "s": "a, {b} [c] \\"d\\": e"\n}');
});

test('text that is not json comes back unchanged', () => {
  assert.equal(prettyJson('Bad gateway'), 'Bad gateway');
  assert.equal(prettyJson(''), '');
});
