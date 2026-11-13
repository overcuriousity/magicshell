import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VARIANTS, compare, neutralNames, reversedOrder, withoutDescriptions } from './variants.js';

const deepFreeze = (o) => {
  if (o && typeof o === 'object') Object.values(o).forEach(deepFreeze);
  return Object.freeze(o);
};

const run = () => ({
  state: 'S',
  questions: [
    {
      key: 'topic',
      type: 'choice',
      text: 'Which?',
      options: [
        { id: 'o1', name: 'billing', description: '' },
        { id: 'o2', name: 'bug', description: 'Something is broken' },
        { id: 'o3', name: 'other', description: 'Anything else' },
      ],
    },
    {
      key: 'urgency',
      type: 'score',
      text: 'How urgent?',
      levels: [
        { id: 'l0', text: 'low' },
        { id: 'l1', text: 'mid' },
        { id: 'l2', text: 'high' },
        { id: 'l3', text: 'critical' },
      ],
    },
    { key: 'angry', type: 'noul', text: 'Angry?' },
  ],
});

const choiceOut = (choice, probabilities) => ({ type: 'choice', choice, probabilities, confidence: 0.9 });
const outcome = (answers) => ({ answers, model: 'm', inputTokens: 1 });

test('removing descriptions keeps names, ids and order', () => {
  const out = withoutDescriptions(run());
  const q = out.questions[0];
  assert.deepEqual(q.options.map((o) => o.name), ['billing', 'bug', 'other']);
  assert.deepEqual(q.options.map((o) => o.id), ['o1', 'o2', 'o3']);
  assert.deepEqual(q.options.map((o) => o.description), ['', '', '']);
});

test('neutral names keep the meaning in the description', () => {
  const q = neutralNames(run()).questions[0];
  assert.deepEqual(q.options.map((o) => o.name), ['A', 'B', 'C']);
  assert.equal(q.options[0].description, 'billing');
  assert.equal(q.options[1].description, 'Something is broken');
  assert.deepEqual(q.options.map((o) => o.id), ['o1', 'o2', 'o3']);
});

test('reversing twice gives the original run', () => {
  assert.deepEqual(reversedOrder(reversedOrder(run())), run());
  assert.deepEqual(reversedOrder(run()).questions[1].levels.map((l) => l.id), ['l3', 'l2', 'l1', 'l0']);
});

test('the input run is not changed', () => {
  const frozen = deepFreeze(run());
  for (const v of VARIANTS) v.apply(frozen);
  assert.deepEqual(frozen, run());
  assert.deepEqual(VARIANTS.map((v) => v.id), ['bare', 'neutral', 'reversed']);
});

test('a renamed option is still compared with itself', () => {
  const a = run();
  const b = neutralNames(a);
  const diff = compare(
    a, outcome({ topic: choiceOut('billing', [0.6, 0.3, 0.1]) }),
    b, outcome({ topic: choiceOut('A', [0.5, 0.4, 0.1]) }),
  ).topic;
  assert.equal(diff.pickChanged, false);
  assert.deepEqual(diff.deltas.map((d) => d.id), ['o1', 'o2', 'o3']);
  assert.ok(Math.abs(diff.deltas[0].delta + 0.1) < 1e-9);
});

test('integer-like names in reversed order compare by id', () => {
  const mk = (names) => ({
    state: '',
    questions: [{ key: 'n', type: 'choice', text: 't', options: names.map(([id, name]) => ({ id, name, description: '' })) }],
  });
  const a = mk([['x1', '1'], ['x2', '2'], ['x10', '10']]);
  const b = mk([['x10', '10'], ['x2', '2'], ['x1', '1']]);
  const diff = compare(
    a, outcome({ n: choiceOut('10', [0.2, 0.3, 0.5]) }),
    b, outcome({ n: choiceOut('10', [0.5, 0.3, 0.2]) }),
  ).n;
  assert.equal(diff.pickChanged, false);
  assert.deepEqual(diff.deltas.map((d) => d.id), ['x1', 'x2', 'x10']);
  for (const d of diff.deltas) assert.ok(Math.abs(d.delta) < 1e-9);
});

test('a reversed scale compares on the original positions', () => {
  const a = run();
  const b = reversedOrder(a);
  const diff = compare(
    a, outcome({ urgency: { type: 'score', score: 1.8, probabilities: [0.1, 0.2, 0.5, 0.2], confidence: 1 } }),
    b, outcome({ urgency: { type: 'score', score: 1.2, probabilities: [0.2, 0.5, 0.2, 0.1], confidence: 1 } }),
  ).urgency;
  assert.equal(diff.pickChanged, false);
  assert.ok(Math.abs(diff.scoreDelta) < 1e-9);
});

test('a score with different level ids has no delta', () => {
  const a = run();
  const b = run();
  b.questions[1].levels[0].id = 'zz';
  const diff = compare(
    a, outcome({ urgency: { type: 'score', score: 1, probabilities: [0, 1, 0, 0], confidence: 1 } }),
    b, outcome({ urgency: { type: 'score', score: 1, probabilities: [0, 1, 0, 0], confidence: 1 } }),
  ).urgency;
  assert.equal(diff.scoreDelta, null);
});

test('a noul that crosses 0.5 is a changed pick', () => {
  const a = run();
  const diff = compare(a, outcome({ angry: { type: 'noul', noul: 0.4 } }), a, outcome({ angry: { type: 'noul', noul: 0.6 } })).angry;
  assert.equal(diff.pickChanged, true);
  assert.ok(Math.abs(diff.delta - 0.2) < 1e-9);
});

test('a question missing from one run is not compared', () => {
  const a = run();
  const b = run();
  b.questions = b.questions.slice(1);
  const out = compare(
    a, outcome({ topic: choiceOut('bug', [0, 1, 0]), angry: { type: 'noul', noul: 0.1 } }),
    b, outcome({ angry: { type: 'noul', noul: 0.1 } }),
  );
  assert.equal(out.topic, null);
  assert.notEqual(out.angry, null);
});

test('a question with a different type is not compared', () => {
  const a = run();
  const b = run();
  b.questions[2] = { key: 'angry', type: 'score', text: 'x', levels: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] };
  const out = compare(a, outcome({ angry: { type: 'noul', noul: 0.1 } }), b, outcome({ angry: { type: 'score', score: 0, probabilities: [1, 0], confidence: 1 } }));
  assert.equal(out.angry, null);
});

test('a question named __proto__ is compared like any other', () => {
  const r = { state: '', questions: [{ key: '__proto__', type: 'noul', text: 'Odd?' }] };
  const out = (noul) => JSON.parse(`{"answers":{"__proto__":{"type":"noul","noul":${noul}}}}`);
  const diff = compare(r, out(0.75), r, out(0.25));
  assert.deepEqual(Object.keys(diff), ['__proto__']);
  assert.equal(diff.__proto__.pickChanged, true);
});

test('options without ids compare their picks by place, and a pick that is not there is unknown', () => {
  const mk = (names) => ({
    state: '',
    questions: [{ key: 'n', type: 'choice', text: 't', options: names.map((name) => ({ name, description: '' })) }],
  });
  const a = mk(['red', 'blue']);
  const b = mk(['red', 'blue']);
  const moved = compare(a, outcome({ n: choiceOut('red', [0.6, 0.4]) }), b, outcome({ n: choiceOut('blue', [0.4, 0.6]) })).n;
  assert.equal(moved.pickChanged, true);
  const kept = compare(a, outcome({ n: choiceOut('red', [0.6, 0.4]) }), b, outcome({ n: choiceOut('red', [0.7, 0.3]) })).n;
  assert.equal(kept.pickChanged, false);
  const lost = compare(a, outcome({ n: choiceOut('red', [0.6, 0.4]) }), b, outcome({ n: choiceOut('green', [0.7, 0.3]) })).n;
  assert.equal(lost.pickChanged, null);
});

test('neutral names are single letters for as many options as a question can have', () => {
  const options = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, name: `n${i}`, description: '' }));
  const q = neutralNames({ state: '', questions: [{ key: 'k', type: 'choice', text: 't', options }] }).questions[0];
  assert.deepEqual(q.options.map((o) => o.name), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
});
