import assert from 'node:assert/strict';
import test from 'node:test';
import { RunError } from '../run-error.js';
import { BUILTIN } from '../setups-builtin.js';
import { createBenchModel, queueRun, SESSION_KEY, takeRun } from './bench-model.js';

const memory = () => {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
};

const memoryStore = () => {
  const entries = [];
  return {
    entries,
    async listSetups() { return []; },
    async saveEntry(e) { entries.push(structuredClone(e)); },
  };
};

const triage = BUILTIN.find((s) => s.id === 'builtin-triage');

// Answers every question of the run it gets: the first option, level 1, 0.25 yes.
const answersFor = (run) =>
  Object.fromEntries(
    run.questions.map((q) => {
      if (q.type === 'choice') {
        const n = q.options.length;
        const probabilities = q.options.map((_, i) => (i === 0 ? 0.7 : 0.3 / (n - 1)));
        return [q.key, { type: 'choice', choice: q.options[0].name.trim(), probabilities, confidence: 0.6 }];
      }
      if (q.type === 'score') {
        const probabilities = q.levels.map((_, i) => (i === 1 ? 1 : 0));
        return [q.key, { type: 'score', score: 1, probabilities, confidence: 0.5 }];
      }
      return [q.key, { type: 'noul', noul: 0.25 }];
    }),
  );

const fakeClient = () => {
  const calls = [];
  return {
    calls,
    async run(run) {
      calls.push(structuredClone(run));
      return {
        answers: answersFor(run),
        model: 'm-1',
        inputTokens: 42,
        totalMs: 120,
        upstreamMs: 80,
        request: '{"state":"x"}',
        response: '{"answers":{}}',
      };
    },
  };
};

let n = 0;
const make = (extra = {}) =>
  createBenchModel({
    client: fakeClient(),
    store: memoryStore(),
    now: () => new Date('2026-11-13T10:00:00Z'),
    uuid: () => `id-${++n}`,
    session: memory(),
    ...extra,
  });

test('a new bench has one empty noul question', () => {
  const m = make();
  assert.deepEqual(m.state.a, { state: '', questions: [{ key: 'q1', type: 'noul', text: '' }] });
  assert.equal(m.state.b, null);
  assert.equal(m.state.resultA, null);
  assert.equal(m.state.busy, null);
  assert.equal(m.state.error, null);
});

test('question keys are q1, q2 and the first free one after a removal', () => {
  const m = make();
  m.addQuestion('choice');
  m.addQuestion('score');
  assert.deepEqual(m.state.a.questions.map((q) => q.key), ['q1', 'q2', 'q3']);
  m.removeQuestion('q2');
  m.addQuestion('noul');
  assert.deepEqual(m.state.a.questions.map((q) => q.key), ['q1', 'q3', 'q2']);
});

test('a new choice starts with two empty options and a score with two empty levels', () => {
  const m = make();
  m.addQuestion('choice');
  m.addQuestion('score');
  const [, choice, score] = m.state.a.questions;
  assert.deepEqual(choice.options.map((o) => [o.name, o.description]), [['', ''], ['', '']]);
  assert.equal(new Set(choice.options.map((o) => o.id)).size, 2);
  assert.deepEqual(score.levels.map((l) => l.text), ['', '']);
});

test('options and levels are added, edited, moved and removed', () => {
  const m = make();
  m.updateQuestion('q1', { type: 'choice' });
  m.addOption('q1');
  const ids = m.state.a.questions[0].options.map((o) => o.id);
  m.updateOption('q1', ids[2], { name: 'c' });
  m.moveOption('q1', ids[2], -1);
  assert.deepEqual(m.state.a.questions[0].options.map((o) => o.id), [ids[0], ids[2], ids[1]]);
  m.moveOption('q1', ids[0], -1);
  assert.deepEqual(m.state.a.questions[0].options.map((o) => o.id), [ids[0], ids[2], ids[1]]);
  m.removeOption('q1', ids[1]);
  assert.deepEqual(m.state.a.questions[0].options.map((o) => o.name), ['', 'c']);
  m.updateQuestion('q1', { type: 'score' });
  assert.equal(m.state.a.questions[0].options, undefined);
  const lid = m.state.a.questions[0].levels[0].id;
  m.updateLevel('q1', lid, { text: 'low' });
  m.addLevel('q1');
  m.moveLevel('q1', lid, 1);
  assert.deepEqual(m.state.a.questions[0].levels.map((l) => l.text), ['', 'low', '']);
  m.removeLevel('q1', lid);
  assert.equal(m.state.a.questions[0].levels.length, 2);
});

test('renaming a question to a key in use is refused', () => {
  const m = make();
  m.addQuestion('noul');
  m.updateQuestion('q2', { key: 'q1' });
  assert.deepEqual(m.state.a.questions.map((q) => q.key), ['q1', 'q2']);
  assert.equal(m.state.error, 'Name each question differently.');
  m.updateQuestion('q2', { key: 'angry' });
  assert.deepEqual(m.state.a.questions.map((q) => q.key), ['q1', 'angry']);
  assert.equal(m.state.error, null);
});

test('running stores one history entry with the run as sent', async () => {
  const client = fakeClient();
  const store = memoryStore();
  const m = make({ client, store });
  m.loadSetup(triage);
  await m.run();
  assert.equal(client.calls.length, 1);
  assert.equal(store.entries.length, 1);
  const e = store.entries[0];
  assert.equal(e.guided, false);
  assert.equal(e.at, '2026-11-13T10:00:00.000Z');
  assert.match(e.id, /^id-/);
  assert.deepEqual(e.run, client.calls[0]);
  assert.equal(e.run.state, triage.sampleState);
  assert.deepEqual(Object.keys(e.reply).sort(), ['answers', 'inputTokens', 'model', 'response', 'upstreamMs']);
  assert.equal(e.reply.model, 'm-1');
  assert.equal(e.totalMs, 120);
  assert.equal(m.state.resultA.inputTokens, 42);
  assert.equal(m.state.busy, null);
});

test('a second run while one is in flight does nothing', async () => {
  let release;
  const calls = [];
  const client = {
    run(run) {
      calls.push(run);
      return new Promise((resolve) => {
        release = () => resolve({ answers: answersFor(run), model: 'm', inputTokens: 1, totalMs: 1, upstreamMs: null, request: '', response: '' });
      });
    },
  };
  const m = make({ client });
  m.updateQuestion('q1', { text: 'Is it?' });
  const first = m.run();
  assert.equal(m.state.busy, 'a');
  m.run();
  m.startVariant();
  m.runVariant();
  assert.equal(calls.length, 1);
  release();
  await first;
  assert.equal(m.state.busy, null);
});

test('an invalid run is refused without calling the model', async () => {
  const client = fakeClient();
  const store = memoryStore();
  const m = make({ client, store });
  await m.run();
  assert.equal(client.calls.length, 0);
  assert.equal(store.entries.length, 0);
  assert.equal(m.state.error, 'Type a question first.');
  m.updateQuestion('q1', { text: 'Is it?' });
  await m.run();
  assert.equal(m.state.error, null);
  assert.equal(client.calls.length, 1);
});

test('a ready variant runs B and leaves A untouched', async () => {
  const client = fakeClient();
  const store = memoryStore();
  const m = make({ client, store });
  m.loadSetup(triage);
  await m.run();
  const a = structuredClone(m.state.a);
  const resultA = m.state.resultA;
  m.startVariant('bare');
  assert.equal(m.state.variant, 'bare');
  assert.ok(m.state.b.questions[0].options.every((o) => o.description === ''));
  await m.runVariant();
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[1].questions[0].options.every((o) => o.description === ''));
  assert.deepEqual(m.state.a, a);
  assert.equal(m.state.resultA, resultA);
  assert.ok(m.state.resultB);
  assert.equal(store.entries.length, 2);
  const d = m.diff();
  assert.deepEqual(Object.keys(d), ['team', 'urgency', 'angry']);
  assert.equal(d.team.pickChanged, false);
});

test('an edited copy runs with its edits', async () => {
  const client = fakeClient();
  const m = make({ client });
  m.loadSetup(triage);
  await m.run();
  m.startVariant();
  assert.equal(m.state.variant, null);
  assert.deepEqual(m.state.b, m.state.a);
  m.editVariant((b) => {
    b.state = 'Other.';
  });
  await m.runVariant();
  assert.equal(client.calls[1].state, 'Other.');
  assert.equal(m.state.a.state, triage.sampleState);
});

test('running A again clears the variant', async () => {
  const m = make();
  m.loadSetup(triage);
  await m.run();
  m.startVariant('reversed');
  await m.runVariant();
  await m.run();
  assert.equal(m.state.b, null);
  assert.equal(m.state.resultB, null);
  assert.equal(m.diff(), null);
});

test('results stay with the run that produced them', async () => {
  const m = make();
  m.loadSetup(triage);
  await m.run();
  m.setState('Changed after the run.');
  m.removeQuestion('angry');
  assert.equal(m.state.ranA.state, triage.sampleState);
  assert.equal(m.state.ranA.questions.length, 3);
  assert.ok(m.state.resultA.answers.angry);
});

test('a failed run shows the sentence and stores nothing', async () => {
  const store = memoryStore();
  const client = {
    async run() {
      throw new RunError('The model took too long to answer. Try again.', 'upstream');
    },
  };
  const m = make({ client, store });
  m.updateQuestion('q1', { text: 'Is it?' });
  await m.run();
  assert.equal(m.state.error, 'The model took too long to answer. Try again.');
  assert.equal(m.state.resultA, null);
  assert.equal(m.state.busy, null);
  assert.equal(store.entries.length, 0);
});

test('an expired session leads to sign-in and keeps the setup', async () => {
  const session = memory();
  const seen = [];
  const client = {
    async run() {
      throw new RunError('Sign in again.', 'auth');
    },
  };
  const m = make({ client, session, mode: 'accounts', navigate: (h) => seen.push(h) });
  m.loadSetup(triage);
  await m.run();
  assert.deepEqual(seen, ['#/sign-in']);
  assert.equal(m.state.error, 'Sign in again.');
  assert.ok(session.getItem(SESSION_KEY));
  const again = make({ session });
  assert.deepEqual(again.state.a, m.state.a);
});

test('an auth error outside accounts mode does not navigate', async () => {
  const seen = [];
  const client = {
    async run() {
      throw new RunError('Sign in first.', 'auth');
    },
  };
  const m = make({ client, mode: 'open', navigate: (h) => seen.push(h) });
  m.updateQuestion('q1', { text: 'Is it?' });
  await m.run();
  assert.deepEqual(seen, []);
});

test('a damaged session falls back to the empty bench', () => {
  const session = memory();
  session.setItem(SESSION_KEY, '{"a":{"questions":"no"}}');
  assert.deepEqual(make({ session }).state.a.questions, [{ key: 'q1', type: 'noul', text: '' }]);
});

test('loading a history run makes it the baseline', async () => {
  const m = make();
  m.loadSetup(triage);
  await m.run();
  m.startVariant('bare');
  await m.runVariant();
  const run = { state: 'Old.', questions: [{ key: 'ok', type: 'noul', text: 'Fine?' }] };
  const result = { answers: { ok: { type: 'noul', noul: 0.9 } }, model: 'm', inputTokens: 3, totalMs: 9, upstreamMs: null, request: '', response: '' };
  m.loadRun(run, result);
  assert.deepEqual(m.state.a, run);
  assert.deepEqual(m.state.ranA, run);
  assert.equal(m.state.resultA, result);
  assert.equal(m.state.b, null);
  assert.equal(m.state.resultB, null);
  m.loadRun({ state: '', questions: [{ key: 'x', type: 'noul', text: 'X?' }] });
  assert.equal(m.state.resultA, null);
});

test('subscribers hear every change', () => {
  const m = make();
  let count = 0;
  const off = m.subscribe(() => (count += 1));
  m.setState('x');
  m.addQuestion('noul');
  off();
  m.setState('y');
  assert.equal(count, 2);
});

test('an error says which run it belongs to', async () => {
  const m = make();
  m.loadSetup(triage);
  await m.run();
  m.startVariant();
  m.editVariant((b) => {
    b.questions[0].options[0].name = '';
  });
  await m.runVariant();
  assert.equal(m.state.error, 'Name every option.');
  assert.equal(m.state.errorFor, 'b');
  m.updateQuestion('q1', { text: '' });
  m.removeQuestion('team');
  m.removeQuestion('urgency');
  m.updateQuestion('angry', { text: '' });
  await m.run();
  assert.equal(m.state.error, 'Type a question first.');
  assert.equal(m.state.errorFor, 'a');
});

test('a queued run is taken once', () => {
  const run = { state: '', questions: [] };
  queueRun(run, { totalMs: 1 });
  assert.deepEqual(takeRun(), { run, result: { totalMs: 1 }, entry: null });
  assert.equal(takeRun(), null);
});

test('an entry does not keep the request twice', async () => {
  const store = memoryStore();
  const m = make({ store, mode: 'open' });
  m.loadSetup(triage);
  await m.run();
  assert.deepEqual(Object.keys(store.entries[0].reply).sort(), ['answers', 'inputTokens', 'model', 'response', 'upstreamMs']);
  assert.equal(m.state.resultA.request, '{"state":"x"}');
});

test('an error that is not a RunError shows one plain sentence, not its text', async () => {
  const client = { async run() { throw new TypeError("Cannot read properties of null (reading 'id')"); } };
  const m = make({ client });
  m.updateQuestion('q1', { text: 'Is it?' });
  await m.run();
  assert.equal(m.state.error, 'Something went wrong. Reload the page and try again.');
});

test('an untouched bench holds nothing, anything typed into it does', () => {
  const m = make();
  assert.equal(m.holdsSomething(), false);
  m.updateQuestion('q1', { type: 'choice' });
  assert.equal(m.holdsSomething(), false);
  m.updateOption('q1', m.state.a.questions[0].options[0].id, { name: 'Red' });
  assert.equal(m.holdsSomething(), true);
  const situation = make();
  situation.setState('  ');
  assert.equal(situation.holdsSomething(), false);
  situation.setState('Rain.');
  assert.equal(situation.holdsSomething(), true);
  const asked = make();
  asked.updateQuestion('q1', { text: 'Wet?' });
  assert.equal(asked.holdsSomething(), true);
});

test('the variant and both results come back after leaving and returning', async () => {
  const session = memory();
  const m = make({ session });
  m.loadSetup(triage);
  await m.run();
  m.startVariant('bare');
  m.editVariant((b) => { b.state = 'Edited B.'; });
  await m.runVariant();
  const back = make({ session });
  for (const k of ['a', 'ranA', 'b', 'variant', 'ranB']) assert.deepEqual(back.state[k], m.state[k], k);
  assert.deepEqual({ ...back.state.resultA, answers: { ...back.state.resultA.answers } }, { ...m.state.resultA, answers: { ...m.state.resultA.answers } });
  assert.deepEqual(Object.keys(back.state.resultB.answers), Object.keys(m.state.resultB.answers));
  assert.equal(back.state.b.state, 'Edited B.');
  assert.ok(back.diff());
});

test('an edited variant that was not run yet comes back without a result', async () => {
  const session = memory();
  const m = make({ session });
  m.loadSetup(triage);
  await m.run();
  m.startVariant(null);
  m.editVariant((b) => { b.state = 'Not run.'; });
  const back = make({ session });
  assert.equal(back.state.b.state, 'Not run.');
  assert.equal(back.state.variant, null);
  assert.equal(back.state.resultB, null);
  assert.ok(back.state.resultA);
});

test('a kept result that no longer answers its run is dropped with what depends on it', async () => {
  const session = memory();
  const m = make({ session });
  m.loadSetup(triage);
  await m.run();
  m.startVariant('bare');
  const saved = JSON.parse(session.getItem(SESSION_KEY));
  saved.resultA.answers = { nope: { type: 'noul', noul: 2 } };
  session.setItem(SESSION_KEY, JSON.stringify(saved));
  const back = make({ session });
  assert.deepEqual(back.state.a, m.state.a);
  assert.equal(back.state.ranA, null);
  assert.equal(back.state.resultA, null);
  assert.equal(back.state.b, null);
});

const why = { words: 2, done: 1, rows: [] };
const handedOver = {
  run: { state: 'Old.', questions: [{ key: 'ok', type: 'noul', text: 'Fine?' }] },
  result: { answers: { ok: { type: 'noul', noul: 0.9 } }, model: 'm', inputTokens: 3, totalMs: 9, upstreamMs: null, request: '', response: '' },
  entry: { id: 'e1', at: '2026-11-13T09:00:00Z', guided: false, run: { state: 'Old.', questions: [{ key: 'ok', type: 'noul', text: 'Fine?' }] }, reply: {}, totalMs: 9 },
};

test('run A learns its entry once saved', async () => {
  const m = make();
  m.loadSetup(triage);
  assert.equal(m.state.entryA, null);
  await m.run();
  assert.ok(m.state.entryA.id);
  assert.deepEqual(m.state.entryA.run, m.state.ranA);
});

test('a run handed over from History brings its entry and kept part', () => {
  const m = make();
  const entry = { ...handedOver.entry, why };
  m.loadRun(handedOver.run, handedOver.result, entry);
  assert.equal(m.state.entryA, entry);
  m.loadRun(handedOver.run);
  assert.equal(m.state.entryA, null);
  queueRun(handedOver.run, handedOver.result, entry);
  assert.equal(takeRun().entry, entry);
  queueRun(handedOver.run);
  assert.equal(takeRun().entry, null);
});

test('a new run A closes Why? and forgets the old entry', async () => {
  const m = make();
  m.loadRun(handedOver.run, handedOver.result, handedOver.entry);
  m.openWhy();
  assert.equal(m.state.whyOpen, true);
  const pending = m.run();
  assert.equal(m.state.whyOpen, false);
  await pending;
  assert.notEqual(m.state.entryA, handedOver.entry);
  assert.equal(m.state.entryA.run.state, 'Old.');
});

test('the old entry is gone before the new save lands', async () => {
  let release;
  const store = { async listSetups() { return []; }, saveEntry: () => new Promise((r) => { release = r; }) };
  const m = make({ store });
  m.loadRun(handedOver.run, handedOver.result, handedOver.entry);
  const done = m.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(m.state.entryA, null);
  release();
  await done;
  assert.ok(m.state.entryA.id);
});

test('openWhy needs an entry and a result; closeWhy closes', () => {
  const m = make();
  m.openWhy();
  assert.equal(m.state.whyOpen, false);
  m.loadRun(handedOver.run, handedOver.result, handedOver.entry);
  m.openWhy();
  assert.equal(m.state.whyOpen, true);
  m.closeWhy();
  assert.equal(m.state.whyOpen, false);
});

test('loading a setup or a run, or starting a variant, closes Why?', () => {
  const m = make();
  const reopen = () => { m.loadRun(handedOver.run, handedOver.result, handedOver.entry); m.openWhy(); };
  reopen();
  m.loadSetup(triage);
  assert.equal(m.state.whyOpen, false);
  reopen();
  m.startVariant('bare');
  assert.equal(m.state.whyOpen, false);
  reopen();
  m.loadRun(handedOver.run);
  assert.equal(m.state.whyOpen, false);
});

test('the entry survives a reload with its result and not without', async () => {
  const session = memory();
  const m = make({ session });
  m.loadSetup(triage);
  await m.run();
  assert.equal(make({ session }).state.entryA.id, m.state.entryA.id);
  const saved = JSON.parse(session.getItem(SESSION_KEY));
  saved.entryA = { nope: true };
  session.setItem(SESSION_KEY, JSON.stringify(saved));
  assert.equal(make({ session }).state.entryA, null);
  saved.entryA = m.state.entryA;
  saved.resultA = null;
  session.setItem(SESSION_KEY, JSON.stringify(saved));
  assert.equal(make({ session }).state.entryA, null);
});

test('run B never gets an entry for Why?', async () => {
  const m = make();
  m.loadSetup(triage);
  await m.run();
  const entry = m.state.entryA;
  m.startVariant('bare');
  await m.runVariant();
  assert.equal(m.state.entryA, entry);
});

test('saveWhy saves entry A again with the part', async () => {
  const store = memoryStore();
  const session = memory();
  const m = make({ store, session });
  m.loadSetup(triage);
  await m.run();
  let heard = 0;
  m.subscribe(() => { heard += 1; });
  await m.saveWhy(m.state.entryA, why);
  assert.equal(heard, 0);
  assert.equal(store.entries.length, 2);
  assert.equal(store.entries[1].id, store.entries[0].id);
  assert.deepEqual(store.entries[1].why, why);
  assert.deepEqual(m.state.entryA.why, why);
  assert.deepEqual(make({ session }).state.entryA.why, why);
});

test('saveWhy after a new run A saves the old entry and leaves the new one alone', async () => {
  const store = memoryStore();
  const m = make({ store });
  m.loadSetup(triage);
  await m.run();
  const old = m.state.entryA;
  await m.run();
  const fresh = m.state.entryA;
  await m.saveWhy(old, why);
  assert.deepEqual(store.entries.at(-1), { ...old, why });
  assert.equal(fresh.why, undefined);
});

test('a slow save of run 1 does not attach its entry to run 2', async () => {
  const releases = [];
  const store = { async listSetups() { return []; }, saveEntry: () => new Promise((r) => releases.push(r)) };
  const m = make({ store });
  m.loadSetup(triage);
  const first = m.run();
  await new Promise((r) => setTimeout(r, 0));
  const second = m.run();
  await new Promise((r) => setTimeout(r, 0));
  releases[0]();
  await first;
  assert.equal(m.state.entryA, null);
  releases[1]();
  await second;
  assert.ok(m.state.entryA);
});

test('Why? cannot be opened during a run and does not open itself for the new result', async () => {
  const releases = [];
  const store = { async listSetups() { return []; }, saveEntry: () => new Promise((r) => releases.push(r)) };
  const m = make({ store });
  m.loadRun(handedOver.run, handedOver.result, handedOver.entry);
  m.openWhy();
  const pending = m.run();
  assert.equal(m.state.busy, 'a');
  m.openWhy();
  assert.equal(m.state.whyOpen, false);
  m.state.whyOpen = true; // as if opened in a way the guard missed
  await new Promise((r) => setTimeout(r, 0));
  releases[0]();
  await pending;
  assert.equal(m.state.whyOpen, false);
  assert.ok(m.state.entryA);
});
