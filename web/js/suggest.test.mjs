import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY, createSuggestions, nextWord } from './suggest.js';

const entry = (at, state, questions) => ({ id: at, at, run: { state, questions } });
const choice = (text, ...names) => ({ key: 'team', type: 'choice', text, options: names.map((n) => ({ id: n, name: n, description: `${n} things` })) });
const history = [
  entry('2026-11-10T10:00:00Z', 'Printer is on fire', [choice('Which team should handle this?', 'billing', 'tech')]),
  entry('2026-11-12T10:00:00Z', 'Printer is out of paper', [choice('Which tool fits?', 'tech', 'sales')]),
];
const setups = [{ name: 'Ticket triage', sampleState: 'I was charged twice', questions: [{ key: 'urgency', type: 'score', text: 'How urgent?', levels: [{ id: 'l1', text: 'can wait' }] }] }];
const s = createSuggestions({ history, setups, scales: [{ levels: ['not at all', 'a little'] }] });

test('the rest of the most recent match, keeping what was typed', () => {
  assert.equal(s.rest('question', 'which t'), 'ool fits?');
  assert.equal(s.rest('question', 'Which te'), 'am should handle this?');
});
test('nothing for empty text, a full value, or no match', () => {
  assert.equal(s.rest('question', ''), '');
  assert.equal(s.rest('question', 'Which tool fits?'), '');
  assert.equal(s.rest('question', 'Which  '), '');
});
test('pools do not mix, and setups and scales feed the grey text', () => {
  assert.equal(s.rest('option', 'Which'), '');
  assert.equal(s.rest('situation', 'I was'), ' charged twice');
  assert.equal(s.rest('level', 'not'), ' at all');
  assert.equal(s.rest('level', 'can'), ' wait');
  assert.equal(s.rest('key', 'te'), 'am');
  assert.equal(s.rest('name', 'Tick'), 'et triage');
});
test('the rest stops at the limit and never inside a surrogate pair', () => {
  assert.equal(s.rest('question', 'Which te', { limit: 10 }), 'am');
  const e = createSuggestions({ history: [entry('2026-11-01T00:00:00Z', 'ab😀cd', [])] });
  assert.equal(e.rest('situation', 'a', { limit: 3 }), 'b');
});
test('a description used with the same option name comes first', () => {
  const h2 = [
    entry('2026-11-01T00:00:00Z', '', [{ key: 'k', text: 'q', options: [{ name: 'tech', description: 'errors and outages' }] }]),
    entry('2026-11-02T00:00:00Z', '', [{ key: 'k', text: 'q', options: [{ name: 'other', description: 'everything else' }] }]),
  ];
  const d = createSuggestions({ history: h2 });
  assert.equal(d.rest('description', 'e'), 'verything else');
  assert.equal(d.rest('description', 'e', { pairedName: 'Tech' }), 'rrors and outages');
});
test('recent and frequent use history only', () => {
  assert.deepEqual(s.recent('question'), ['Which tool fits?', 'Which team should handle this?']);
  assert.deepEqual(s.recent('situation', 1), ['Printer is out of paper']);
  assert.deepEqual(s.frequent('option'), ['tech', 'sales', 'billing']);
  assert.deepEqual(s.frequent('option', 5, ['TECH']), ['sales', 'billing']);
  assert.deepEqual(s.recent('level'), []);
});
test('the same text in another case is one value with its latest spelling', () => {
  const c = createSuggestions({ history: [entry('2026-11-01T00:00:00Z', '', [choice('q', 'Tech')]), entry('2026-11-02T00:00:00Z', '', [choice('q', 'tech')])] });
  assert.deepEqual(c.frequent('option'), ['tech']);
});
test('broken entries and setups are skipped', () => {
  const b = createSuggestions({ history: [null, {}, { at: 'x', run: { state: 5, questions: 'no' } }, { at: 'y', run: { questions: [null, { text: 7, options: [{}, null] }] } }, ...history], setups: [null, { questions: [{ levels: 'no' }] }] });
  assert.equal(b.rest('question', 'Which te'), 'am should handle this?');
});
test('nextWord takes leading whitespace and one word', () => {
  assert.equal(nextWord('am should'), 'am');
  assert.equal(nextWord(' should handle'), ' should');
  assert.equal(nextWord('\n\nnext line'), '\n\nnext');
  assert.equal(nextWord('  '), '  ');
  assert.equal(nextWord(''), '');
});
test('EMPTY offers nothing', () => {
  assert.equal(EMPTY.rest('question', 'W'), '');
  assert.deepEqual(EMPTY.recent('question'), []);
});
test('500 long situations answer a keystroke quickly', () => {
  const many = Array.from({ length: 500 }, (_, i) => entry(`2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, `case ${i} ${'x'.repeat(8000)}`, []));
  const big = createSuggestions({ history: many });
  const t = performance.now();
  for (let i = 0; i < 20; i++) big.rest('situation', 'case 49');
  assert.ok(performance.now() - t < 50 * 20);
});
test('setups and scales do not change the order of the history rows', () => {
  const opt = (name) => ({ key: 'k', text: 'q', options: [{ name, description: '' }] });
  const setup = { name: 's', sampleState: '', questions: [opt('alpha')] };
  const h = [entry('2026-11-01T00:00:00Z', '', [opt('alpha')]), entry('2026-11-02T00:00:00Z', '', [opt('beta')]), entry('2026-11-03T00:00:00Z', '', [opt('beta')])];
  const o = createSuggestions({ history: h, setups: [setup, setup, setup] });
  assert.deepEqual(o.frequent('option'), ['beta', 'alpha']);
});
