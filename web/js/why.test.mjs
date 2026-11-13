import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WHY_SAVE_EVERY,
  addWord,
  canAsk,
  costNote,
  describe,
  emptyWhy,
  fits,
  legend,
  measured,
  pickOf,
  splitWords,
  strongest,
  without,
  wordInfo,
} from './why.js';

const STATE = 'We are four people, one is vegetarian, and it is raining.';

const dinner = {
  key: 'dinner',
  type: 'choice',
  text: 'What should we have for dinner tonight?',
  options: [
    { id: 'o1', name: 'pizza', description: 'Order pizza' },
    { id: 'o2', name: 'sushi', description: 'Go out for sushi' },
    { id: 'o3', name: 'home', description: 'Cook at home' },
  ],
};
const urgency = {
  key: 'urgency',
  type: 'score',
  text: 'How urgent is this?',
  levels: [
    { id: 'l0', text: 'Not urgent' },
    { id: 'l1', text: 'Can wait a week' },
    { id: 'l2', text: 'Should be handled today' },
    { id: 'l3', text: 'Drop everything' },
  ],
};
const wet = { key: 'wet', type: 'noul', text: 'Is water wet?' };

const run = { state: STATE, questions: [dinner, urgency, wet] };

const choiceAns = (choice, probabilities, confidence = 0.2) => ({ type: 'choice', choice, probabilities, confidence });
const scoreAns = (score) => ({ type: 'score', score, probabilities: [0.04, 0.02, 0.62, 0.32], confidence: 0.58 });
const noulAns = (noul) => ({ type: 'noul', noul });

const base = {
  dinner: choiceAns('sushi', [0.2236, 0.4725, 0.3039]),
  urgency: scoreAns(2.2296),
  wet: noulAns(0.9437),
};

const deepFreeze = (o) => {
  if (o && typeof o === 'object') Object.values(o).forEach(deepFreeze);
  return Object.freeze(o);
};

// A why with one measured word per value for a single question set.
const whyWith = (vals, flips = {}) => {
  const w = emptyWhy(run);
  w.done = vals.length;
  w.q.dinner = { vals: [...vals], flips };
  w.q.urgency = { vals: vals.map(() => 2), flips: {} };
  w.q.wet = { vals: vals.map(() => 0.9), flips: {} };
  return w;
};

test('WHY_SAVE_EVERY', () => {
  assert.equal(WHY_SAVE_EVERY, 25);
});

test('splitWords finds runs of non-whitespace', () => {
  assert.equal(splitWords(STATE).length, 11);
  assert.deepEqual(splitWords('ab  c'), [
    { start: 0, end: 2 },
    { start: 4, end: 5 },
  ]);
  assert.equal(splitWords('  a  b\nc d ').length, 4);
  assert.equal(splitWords('').length, 0);
  assert.equal(splitWords(' \n ').length, 0);
  assert.equal(splitWords('a﻿b').length, 2);
});

test('without removes the word and the gap after it', () => {
  const s = 'a  b\nc';
  const w = splitWords(s);
  assert.equal(without(s, w, 0), 'b\nc');
  assert.equal(without(s, w, 1), 'a  c');
  assert.equal(without(s, w, 2), 'a  b');
  assert.equal(without('a', splitWords('a'), 0), '');
});

test('without keeps every other character', () => {
  const state = '  x  yy\n z  ';
  const w = splitWords(state);
  w.forEach((word, i) => {
    const from = i + 1 < w.length ? word.start : w[i - 1].end;
    const to = i + 1 < w.length ? w[i + 1].start : word.end;
    assert.equal(without(state, w, i), state.slice(0, from) + state.slice(to));
  });
});

test('measured and pickOf per type', () => {
  assert.equal(pickOf(dinner, base.dinner), 1);
  assert.equal(pickOf(dinner, choiceAns(' home ', [0, 0, 1])), 2);
  assert.equal(measured(dinner, base.dinner), 0.4725);
  assert.equal(pickOf(urgency, scoreAns(2.2296)), 2);
  assert.equal(pickOf(urgency, scoreAns(1.5)), 2);
  assert.equal(pickOf(urgency, scoreAns(9)), 3);
  assert.equal(measured(urgency, base.urgency), 2.2296);
  assert.equal(pickOf(wet, noulAns(0.5)), true);
  assert.equal(pickOf(wet, noulAns(0.49)), false);
  assert.equal(measured(wet, base.wet), 0.9437);
});

test('addWord appends for the original pick and records a flip', () => {
  const why = deepFreeze(emptyWhy(run));
  const reduced = {
    dinner: choiceAns('pizza', [0.5, 0.21, 0.29]),
    urgency: scoreAns(2.2296),
    wet: noulAns(0.9437),
  };
  const next = addWord(why, run, base, reduced);
  assert.deepEqual(next.q.dinner, { vals: [0.21], flips: { 0: 0 } });
  assert.deepEqual(next.q.urgency, { vals: [2.2296], flips: {} });
  assert.deepEqual(next.q.wet, { vals: [0.9437], flips: {} });
  assert.equal(next.done, 1);
  assert.equal(next.v, 1);
  assert.equal(next.words, 11);
  assert.equal(why.done, 0);
  assert.deepEqual(why.q.dinner, { vals: [], flips: {} });
  const second = addWord(next, run, base, {
    ...reduced,
    wet: noulAns(0.3),
    urgency: scoreAns(1.4),
  });
  assert.equal(second.done, 2);
  assert.deepEqual(second.q.wet, { vals: [0.9437, 0.3], flips: { 1: false } });
  assert.deepEqual(second.q.urgency.flips, { 1: 1 });
});

test('addWord rounds to four decimals', () => {
  const reduced = { ...base, dinner: choiceAns('sushi', [0.2, 0.20876543, 0.6]) };
  assert.equal(addWord(emptyWhy(run), run, base, reduced).q.dinner.vals[0], 0.2088);
});

test('wordInfo: effect, direction and step', () => {
  const why = whyWith([0.2125, 0.5625, 0.4685], { 0: 0 });
  const a = wordInfo(why, run, base, 'dinner', 0);
  assert.equal(a.before, 0.4725);
  assert.equal(a.after, 0.2125);
  assert.ok(Math.abs(a.delta + 0.26) < 1e-9);
  assert.equal(a.effect, true);
  assert.equal(a.dir, 'towards');
  assert.equal(a.step, 5);
  assert.equal(a.flip, 0);
  const b = wordInfo(why, run, base, 'dinner', 1);
  assert.equal(b.dir, 'away');
  assert.equal(b.step, 2);
  assert.equal(b.flip, undefined);
  const c = wordInfo(why, run, base, 'dinner', 2);
  assert.equal(c.effect, false);
  assert.equal(c.dir, null);
  assert.equal(c.step, 0);

  const sw = whyWith([0]);
  sw.q.urgency.vals = [1.4296, 2.2696, 2.4296];
  const s0 = wordInfo(sw, run, base, 'urgency', 0);
  assert.equal(s0.effect, true);
  assert.equal(s0.step, 5);
  assert.equal(s0.dir, 'towards');
  sw.done = 3;
  const s1 = wordInfo(sw, run, base, 'urgency', 1);
  assert.equal(s1.effect, false);
  assert.equal(s1.step, 0);
  assert.equal(wordInfo(sw, run, base, 'urgency', 2).effect, true);

  // a flip without effect still has step 0
  const f = whyWith([0.4725], { 0: 2 });
  const fi = wordInfo(f, run, base, 'dinner', 0);
  assert.equal(fi.effect, false);
  assert.equal(fi.step, 0);
  assert.equal(fi.flip, 2);

  const n = whyWith([0]);
  n.q.wet.vals = [0.6437];
  assert.equal(wordInfo(n, run, base, 'wet', 0).step, 5);
});

test('wordInfo is null for an unmeasured word', () => {
  const why = whyWith([0.2]);
  assert.equal(wordInfo(why, run, base, 'dinner', 1), null);
  assert.equal(wordInfo(emptyWhy(run), run, base, 'dinner', 0), null);
});

test('strongest lists only words with an effect or a flip, largest first, at most n', () => {
  const why = whyWith([0.4725, 0.3725, 0.6225, 0.4725, 0.4225, 0.4725], { 3: 0 });
  const list = strongest(why, run, base, 'dinner');
  assert.deepEqual(
    list.map((w) => w.index),
    [2, 1, 4, 3],
  );
  assert.equal(list[0].dir, 'away');
  assert.deepEqual(
    strongest(why, run, base, 'dinner', 2).map((w) => w.index),
    [2, 1],
  );
});

test('describe writes the numbers line per type', () => {
  const info = (question, vals, flip) => {
    const why = whyWith([0], flip === undefined ? {} : { 0: flip });
    why.q[question.key] = { vals: [vals], flips: flip === undefined ? {} : { 0: flip } };
    return wordInfo(why, run, base, question.key, 0);
  };
  assert.equal(
    describe(dinner, info(dinner, 0.2125, 0)),
    'without it: sushi 47\u00a0% → 21\u00a0% (−26), pick becomes pizza',
  );
  assert.equal(describe(dinner, info(dinner, 0.5625)), 'without it: sushi 47\u00a0% → 56\u00a0% (+9)');
  assert.equal(describe(dinner, info(dinner, 0.4725)), 'without it: sushi 47\u00a0% → 47\u00a0% (±0)');
  assert.equal(
    describe(urgency, info(urgency, 1.4296, 1)),
    'without it: 2.2 → 1.4 (−0.8), nearest becomes Can wait a week',
  );
  assert.equal(describe(urgency, info(urgency, 2.2496)), 'without it: 2.2 → 2.2 (±0)');
  assert.equal(describe(urgency, info(urgency, 2.6296)), 'without it: 2.2 → 2.6 (+0.4)');
  assert.equal(
    describe(wet, info(wet, 0.4137, false)),
    'without it: yes 94\u00a0% → 41\u00a0% (−53), answer becomes No',
  );
  assert.equal(describe(wet, info(wet, 0.9637)), 'without it: yes 94\u00a0% → 96\u00a0% (+2)');
  assert.equal(describe(wet, info(wet, 0.1, false)).includes('answer becomes No'), true);
});

test('legend follows the question type', () => {
  assert.deepEqual(legend(dinner, base.dinner), {
    towards: 'pulled towards sushi',
    away: 'pulled away from sushi',
  });
  assert.deepEqual(legend(urgency, base.urgency), {
    towards: 'raised the score',
    away: 'lowered the score',
  });
  assert.deepEqual(legend(wet, noulAns(0.1)), { towards: 'towards yes', away: 'towards no' });
});

test('fits accepts what addWord builds and refuses anything else', () => {
  const reduced = { ...base, dinner: choiceAns('pizza', [0.5, 0.21, 0.29]) };
  const good = addWord(emptyWhy(run), run, base, reduced);
  assert.equal(fits(emptyWhy(run), run), true);
  assert.equal(fits(good, run), true);
  const bad = (edit) => {
    const w = JSON.parse(JSON.stringify(good));
    edit(w);
    return fits(w, run);
  };
  assert.equal(fits(null, run), false);
  assert.equal(fits(undefined, run), false);
  assert.equal(bad((w) => (w.v = 2)), false);
  assert.equal(bad((w) => (w.words = 10)), false);
  assert.equal(bad((w) => delete w.q.wet), false);
  assert.equal(bad((w) => (w.q.extra = { vals: [0], flips: {} })), false);
  assert.equal(bad((w) => (w.q.dinner.vals = [])), false);
  assert.equal(bad((w) => (w.q.dinner.vals = [null])), false);
  assert.equal(bad((w) => (w.q.dinner.vals = ['0.2'])), false);
  assert.equal(bad((w) => (w.q.dinner.flips = { 1: 0 })), false);
  assert.equal(bad((w) => (w.q.dinner.flips = { 0: 7 })), false);
  assert.equal(bad((w) => (w.q.wet.flips = { 0: 1 })), false);
  assert.equal(bad((w) => (w.done = 12)), false);
});

test('canAsk at the limits', () => {
  const of = (state) => ({ state, questions: [] });
  const words = (n) => Array.from({ length: n }, () => 'w').join(' ');
  assert.deepEqual(canAsk(of(''), 300), { ok: false, count: 0, reason: 'Why? needs a situation.' });
  assert.deepEqual(canAsk(of(words(300)), 300), { ok: true, count: 300 });
  assert.deepEqual(canAsk(of(words(301)), 300), {
    ok: false,
    count: 301,
    reason: 'Why? works up to 300 words; this situation has 301.',
  });
  assert.equal(canAsk(of('a b'), null).ok, false);
  assert.equal(canAsk(of('a b'), 0).ok, false);
});

test('costNote', () => {
  assert.equal(costNote(11), 'asks 11 more times, once per word');
  assert.equal(costNote(1), 'asks 1 more time, once per word');
});
