import assert from 'node:assert/strict';
import test from 'node:test';
import { RunError } from '../run-error.js';
import { createGuidedModel, loadable, queueGuidedRun, SESSION_KEY, takeGuidedRun } from './guided-model.js';

const memory = () => {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
};

const memoryStore = () => {
  const entries = [];
  return {
    entries,
    async saveEntry(e) { entries.push(structuredClone(e)); },
  };
};

const answersFor = (run) =>
  Object.fromEntries(
    run.questions.map((q) => {
      if (q.type === 'choice') {
        const n = q.options.length;
        return [q.key, { type: 'choice', choice: q.options[1].name.trim(), probabilities: q.options.map((_, i) => (i === 1 ? 0.7 : 0.3 / (n - 1))), confidence: 0.6 }];
      }
      if (q.type === 'score') return [q.key, { type: 'score', score: 2, probabilities: q.levels.map((_, i) => (i === 2 ? 1 : 0)), confidence: 0.5 }];
      return [q.key, { type: 'noul', noul: 0.8 }];
    }),
  );

const fakeClient = ({ fail = null, hold = false } = {}) => {
  const calls = [];
  let release;
  const gate = hold ? new Promise((r) => { release = r; }) : null;
  return {
    calls,
    release: () => release?.(),
    async run(run) {
      calls.push(structuredClone(run));
      if (gate) await gate;
      if (fail) throw fail;
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
const make = (extra = {}) => {
  const client = extra.client ?? fakeClient();
  const store = extra.store ?? memoryStore();
  const model = createGuidedModel({
    client,
    store,
    now: () => new Date('2026-11-13T10:00:00Z'),
    uuid: () => `id-${++n}`,
    session: memory(),
    ...extra,
  });
  return { model, client, store };
};

test('the guide starts at step 1 with a yes-or-no question', () => {
  const { model } = make();
  const s = model.state;
  assert.equal(s.step, 1);
  assert.equal(s.kind, 'noul');
  assert.equal(s.question, '');
  assert.deepEqual(s.options, []);
  assert.equal(s.context, '');
  assert.equal(s.busy, false);
  assert.equal(s.result, null);
  assert.equal(s.error, null);
});

test('a yes-or-no question becomes a noul run with the context as the situation', () => {
  const { model } = make();
  model.next();
  model.setQuestion('Is it raining?');
  model.next();
  model.setContext('I look out of the window and see wet streets.');
  assert.equal(model.state.step, 3);
  assert.deepEqual(model.toRun(), {
    state: 'I look out of the window and see wet streets.',
    questions: [{ key: 'q1', type: 'noul', text: 'Is it raining?' }],
  });
});

test('a choice needs two options before asking', async () => {
  const { model, client } = make();
  model.setKind('choice');
  model.next();
  model.setQuestion('What should we have for dinner tonight?');
  model.next();
  model.addOption('Pizza');
  model.addOption('   ');
  await model.ask();
  assert.equal(model.state.error, 'Add at least 2 options.');
  assert.equal(client.calls.length, 0);
  assert.equal(model.state.step, 3);
  model.addOption('Sushi');
  assert.equal(model.state.error, null);
  await model.ask();
  assert.equal(client.calls.length, 1);
  assert.equal(model.state.step, 'result');
  assert.deepEqual(client.calls[0].questions[0].options.map((o) => o.name), ['Pizza', 'Sushi']);
  assert.equal(model.state.result.answer.choice, 'Sushi');
});

test('options are removed by id', () => {
  const { model } = make();
  model.setKind('choice');
  model.addOption('Pizza');
  model.addOption('Sushi');
  model.removeOption(model.state.options[0].id);
  assert.deepEqual(model.state.options.map((o) => o.name), ['Sushi']);
});

test('a rating on the 1 to 10 scale becomes a score with ten levels', () => {
  const { model } = make();
  model.setKind('score');
  model.setQuestion('How good was the film?');
  model.setScale('1-10');
  const q = model.toRun().questions[0];
  assert.equal(q.type, 'score');
  assert.deepEqual(q.levels.map((l) => l.text), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
});

test('a rating on my own scale uses the levels typed', async () => {
  const { model, client } = make();
  model.setKind('score');
  model.setQuestion('How spicy?');
  model.setScale('own');
  assert.equal(model.state.levels.length, 2);
  model.setLevels([{ id: 'a', text: 'mild' }, { id: 'b', text: 'hot' }, { id: 'c', text: 'fire' }]);
  await model.ask();
  assert.deepEqual(client.calls[0].questions[0].levels.map((l) => l.text), ['mild', 'hot', 'fire']);
});

test('an empty question cannot be passed', () => {
  const { model } = make();
  model.next();
  model.setQuestion('   ');
  model.next();
  assert.equal(model.state.step, 2);
  assert.equal(model.state.error, 'Type a question first.');
  model.setQuestion('Is it late?');
  assert.equal(model.state.error, null);
  model.next();
  assert.equal(model.state.step, 3);
  model.back();
  model.back();
  assert.equal(model.state.step, 1);
});

test('asking stores one guided history entry', async () => {
  const { model, store } = make();
  model.setQuestion('Is it raining?');
  model.setContext('Wet streets.');
  await model.ask();
  assert.equal(store.entries.length, 1);
  const e = store.entries[0];
  assert.equal(e.guided, true);
  assert.equal(e.at, '2026-11-13T10:00:00.000Z');
  assert.match(e.id, /^id-\d+$/);
  assert.deepEqual(e.run, { state: 'Wet streets.', questions: [{ key: 'q1', type: 'noul', text: 'Is it raining?' }] });
  assert.deepEqual(e.reply, {
    answers: { q1: { type: 'noul', noul: 0.8 } },
    model: 'm-1',
    inputTokens: 42,
    upstreamMs: 80,
    request: '{"state":"x"}',
    response: '{"answers":{}}',
  });
  assert.equal(e.totalMs, 120);
  assert.equal(model.state.step, 'result');
  assert.deepEqual(model.state.result.question, { key: 'q1', type: 'noul', text: 'Is it raining?' });
  assert.deepEqual(model.state.result.answer, { type: 'noul', noul: 0.8 });
});

test('asking twice sends one request', async () => {
  const client = fakeClient({ hold: true });
  const { model, store } = make({ client });
  model.setQuestion('Is it raining?');
  const first = model.ask();
  assert.equal(model.state.busy, true);
  const second = model.ask();
  client.release();
  await Promise.all([first, second]);
  assert.equal(client.calls.length, 1);
  assert.equal(store.entries.length, 1);
  assert.equal(model.state.busy, false);
});

test('a failed ask shows the sentence, stays on the step and stores nothing', async () => {
  const { model, store } = make({ client: fakeClient({ fail: new RunError('The model endpoint did not answer in time.', 'timeout') }) });
  model.next();
  model.setQuestion('Is it raining?');
  model.next();
  await model.ask();
  assert.equal(model.state.error, 'The model endpoint did not answer in time.');
  assert.equal(model.state.step, 3);
  assert.equal(store.entries.length, 0);
});

test('an expired session leads to sign-in in accounts mode', async () => {
  const went = [];
  const { model } = make({ mode: 'accounts', navigate: (h) => went.push(h), client: fakeClient({ fail: new RunError('Sign in again.', 'auth') }) });
  model.setQuestion('Is it raining?');
  await model.ask();
  assert.deepEqual(went, ['#/sign-in']);
  assert.equal(model.state.question, 'Is it raining?');
});

test('ask another keeps the options and clears the question', async () => {
  const { model } = make();
  model.setKind('choice');
  model.setQuestion('Dinner?');
  model.addOption('Pizza');
  model.addOption('Sushi');
  model.setContext('Four people.');
  await model.ask();
  model.askAnother();
  const s = model.state;
  assert.equal(s.step, 2);
  assert.equal(s.question, '');
  assert.equal(s.kind, 'choice');
  assert.deepEqual(s.options.map((o) => o.name), ['Pizza', 'Sushi']);
  assert.equal(s.context, 'Four people.');
  assert.equal(s.result, null);
});

test('start over clears everything', async () => {
  const { model } = make();
  model.setKind('score');
  model.setScale('urgency');
  model.setQuestion('How urgent?');
  model.setContext('Server down.');
  await model.ask();
  model.startOver();
  const s = model.state;
  assert.equal(s.step, 1);
  assert.equal(s.kind, 'noul');
  assert.equal(s.question, '');
  assert.deepEqual(s.options, []);
  assert.deepEqual(s.levels, []);
  assert.equal(s.scaleId, '1-5');
  assert.equal(s.context, '');
  assert.equal(s.result, null);
  assert.equal(s.error, null);
});

test('the run carries over to the bench unchanged', async () => {
  const { createBenchModel } = await import('./bench-model.js');
  const { model } = make();
  model.setKind('choice');
  model.setQuestion('Dinner?');
  model.addOption('Pizza');
  model.addOption('Sushi');
  model.setContext('Rain.');
  const run = model.toRun();
  const bench = createBenchModel({ client: fakeClient(), store: memoryStore(), session: memory(), uuid: () => `b-${++n}` });
  bench.loadRun(run);
  assert.deepEqual(bench.state.a, run);
});

test('a single-question run loads at step 2 and comes back the same', () => {
  const { model } = make();
  const run = {
    state: 'Rain.',
    questions: [{ key: 'q1', type: 'choice', text: 'Dinner?', options: [{ id: 'o1', name: 'Pizza', description: 'hot' }, { id: 'o2', name: 'Sushi', description: '' }] }],
  };
  assert.equal(model.load(run), true);
  assert.equal(model.state.step, 2);
  assert.equal(model.state.question, 'Dinner?');
  assert.deepEqual(model.toRun(), run);
});

test('a loaded rating finds its ready scale, or becomes my own', () => {
  const { model } = make();
  const levels = (...t) => t.map((text, i) => ({ id: `l${i + 1}`, text }));
  model.load({ state: '', questions: [{ key: 'u', type: 'score', text: 'How urgent?', levels: levels('can wait', 'this week', 'today', 'right now') }] });
  assert.equal(model.state.scaleId, 'urgency');
  model.load({ state: '', questions: [{ key: 'q1', type: 'score', text: 'Spice?', levels: levels('mild', 'hot') }] });
  assert.equal(model.state.scaleId, 'own');
  assert.deepEqual(model.state.levels.map((l) => l.text), ['mild', 'hot']);
});

test('a run of several questions is not loaded', () => {
  const { model } = make();
  model.setQuestion('Kept?');
  const two = { state: '', questions: [{ key: 'a', type: 'noul', text: 'A?' }, { key: 'b', type: 'noul', text: 'B?' }] };
  assert.equal(model.load(two), false);
  assert.equal(model.state.question, 'Kept?');
});

test('the entered setup survives a reload of the page', () => {
  const session = memory();
  const first = make({ session }).model;
  first.setKind('choice');
  first.next();
  first.setQuestion('Dinner?');
  first.addOption('Pizza');
  assert.ok(session.data.has(SESSION_KEY));
  const again = make({ session }).model;
  assert.equal(again.state.step, 2);
  assert.equal(again.state.kind, 'choice');
  assert.equal(again.state.question, 'Dinner?');
  assert.deepEqual(again.state.options.map((o) => o.name), ['Pizza']);
  session.setItem(SESSION_KEY, '{"step":9');
  assert.equal(make({ session }).model.state.step, 1);
});

test('subscribers hear every change', () => {
  const { model } = make();
  let heard = 0;
  const off = model.subscribe(() => { heard += 1; });
  model.setKind('choice');
  model.next();
  off();
  model.back();
  assert.equal(heard, 2);
});

test('a run the guide cannot take leaves its draft alone', () => {
  const { model } = make();
  model.setQuestion('Mine?');
  model.setContext('Kept.');
  const two = { state: 'x', questions: [{ key: 'a', type: 'noul', text: 'A?' }, { key: 'b', type: 'noul', text: 'B?' }] };
  assert.equal(loadable(two), false);
  assert.equal(model.load(two), false);
  assert.equal(model.state.question, 'Mine?');
  assert.equal(model.state.context, 'Kept.');
});

test('the guide holds something once a question, an option or context is entered', () => {
  const { model } = make();
  assert.equal(model.holdsSomething(), false);
  model.setKind('score');
  assert.equal(model.holdsSomething(), false);
  model.setContext('  ');
  assert.equal(model.holdsSomething(), false);
  model.setContext('Rain.');
  assert.equal(model.holdsSomething(), true);
  model.setContext('');
  model.setKind('choice');
  model.addOption('Red');
  assert.equal(model.holdsSomething(), true);
});

test('a run queued for the guide is taken once', () => {
  const run = { state: '', questions: [{ key: 'q1', type: 'noul', text: 'Wet?' }] };
  queueGuidedRun(run);
  assert.equal(takeGuidedRun(), run);
  assert.equal(takeGuidedRun(), null);
});
