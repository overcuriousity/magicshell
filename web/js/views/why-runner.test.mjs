import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunError } from '../run-error.js';
import { createWhyRunner } from './why-runner.js';

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const question = { key: 'q', type: 'noul', text: 'Go?' };
const entryOf = (state) => ({
  id: 'e1',
  run: { questions: [question], state, extra: 'kept' },
  reply: { answers: { q: { noul: 0.7 } } },
});
const answer = { answers: { q: { noul: 0.4 } } };

// replies: an array of results or errors; a function may be used for control.
function fakeClient(replies) {
  const sent = [];
  let inFlight = 0;
  return {
    sent,
    async why(run) {
      assert.equal(inFlight, 0, 'a call is already in flight');
      inFlight += 1;
      sent.push(run);
      try {
        await Promise.resolve();
        const r = typeof replies === 'function' ? await replies(sent.length - 1) : replies[sent.length - 1] ?? answer;
        if (r instanceof Error) throw r;
        return r;
      } finally {
        inFlight -= 1;
      }
    },
  };
}

function fakeSave(failWith) {
  const parts = [];
  const save = async (why) => {
    parts.push(why);
    if (failWith) throw failWith;
  };
  return { parts, save };
}

const make = (state, client, save, extra = {}) =>
  createWhyRunner({ client, entry: entryOf(state), save: save.save, ...extra });

test('asks once per word, in order, each without that word', async () => {
  const client = fakeClient([]);
  await make('a b c', client, fakeSave()).start();
  assert.deepEqual(client.sent.map((r) => r.state), ['b c', 'a c', 'a b']);
});

test('uses the run of the entry, not anything else', async () => {
  const client = fakeClient([]);
  await make('a b', client, fakeSave()).start();
  assert.ok(client.sent.every((r) => r.extra === 'kept' && r.questions[0] === question));
});

test('marks the word being asked and ends done', async () => {
  const client = fakeClient([]);
  const runner = make('a b c', client, fakeSave());
  const seen = [];
  runner.subscribe((s) => seen.push([s.phase, s.at, s.why?.done]));
  assert.equal(runner.state.phase, 'idle');
  await runner.start();
  const ats = [...new Set(seen.filter(([p, at]) => p === 'running' && at !== null).map(([, at]) => at))];
  assert.deepEqual(ats, [0, 1, 2]);
  assert.equal(runner.state.phase, 'done');
  assert.equal(runner.state.at, null);
  assert.equal(runner.state.why.done, 3);
  assert.equal(runner.state.error, null);
});

test('never has two calls in flight, and a second start does nothing', async () => {
  const client = fakeClient([]);
  const runner = make('a b c', client, fakeSave());
  const first = runner.start();
  await runner.start();
  await first;
  assert.equal(client.sent.length, 3);
});

test('unsubscribe stops notifications', async () => {
  const runner = make('a', fakeClient([]), fakeSave());
  let n = 0;
  const off = runner.subscribe(() => (n += 1));
  off();
  await runner.start();
  assert.equal(n, 0);
});

test('saves every 25 words and once at the end', async () => {
  const save = fakeSave();
  await make(words(60), fakeClient([]), save).start();
  assert.deepEqual(save.parts.map((p) => p.done), [25, 50, 60]);
});

test('a run that ends exactly on a save point saves once for it', async () => {
  const save = fakeSave();
  await make(words(50), fakeClient([]), save).start();
  assert.deepEqual(save.parts.map((p) => p.done), [25, 50]);
});

test('stop keeps what was measured, saves it and discards the call in flight', async () => {
  let runner;
  const client = fakeClient((i) => {
    if (i === 2) runner.stop();
    return answer;
  });
  const save = fakeSave();
  runner = make('a b c d', client, save);
  await runner.start();
  assert.equal(runner.state.phase, 'stopped');
  assert.equal(runner.state.why.done, 2);
  assert.equal(runner.state.error, null);
  assert.equal(runner.state.at, null);
  assert.deepEqual(save.parts.map((p) => p.done), [2]);
  assert.equal(client.sent.length, 3);
});

test('a failed call stops with its sentence and saves the rest', async () => {
  const sentence = 'Too many questions. Wait a minute and try again.';
  const client = fakeClient([answer, answer, new RunError(sentence, 'limit')]);
  const save = fakeSave();
  const runner = make('a b c d', client, save);
  await runner.start();
  assert.equal(runner.state.phase, 'stopped');
  assert.equal(runner.state.error, sentence);
  assert.deepEqual(save.parts.map((p) => p.done), [2]);
  assert.equal(client.sent.length, 3);
});

test('an expired session stops and calls onAuth', async () => {
  let auth = 0;
  const client = fakeClient([answer, new RunError('Sign in again.', 'auth')]);
  const runner = make('a b c', client, fakeSave(), { onAuth: () => (auth += 1) });
  await runner.start();
  assert.equal(runner.state.phase, 'stopped');
  assert.equal(runner.state.error, 'Sign in again.');
  assert.equal(auth, 1);
});

test('a failed save stops the run with its sentence', async () => {
  const client = fakeClient([]);
  const save = fakeSave(new RunError('Could not save.', 'network'));
  const runner = make(words(30), client, save);
  await runner.start();
  assert.equal(runner.state.phase, 'stopped');
  assert.equal(runner.state.error, 'Could not save.');
  assert.equal(client.sent.length, 25);
  assert.equal(save.parts.length, 1);
});

test('a failed final save ends stopped with its sentence', async () => {
  const save = fakeSave(new RunError('Could not save.', 'network'));
  const runner = make('a b', fakeClient([]), save);
  await runner.start();
  assert.equal(runner.state.phase, 'stopped');
  assert.equal(runner.state.error, 'Could not save.');
});

test('nothing measured means nothing saved', async () => {
  const save = fakeSave();
  const runner = make('a b', fakeClient([new RunError('Down.', 'network')]), save);
  await runner.start();
  assert.equal(runner.state.phase, 'stopped');
  assert.equal(save.parts.length, 0);
});

test('an unreadable reply stops like a failed call', async () => {
  const client = fakeClient([answer, new RunError('The model sent an unreadable reply.', 'upstream')]);
  const save = fakeSave();
  const runner = make('a b c', client, save);
  await runner.start();
  assert.equal(runner.state.phase, 'stopped');
  assert.equal(runner.state.error, 'The model sent an unreadable reply.');
  assert.deepEqual(save.parts.map((p) => p.done), [1]);
});

test('start after the end starts over from an empty part', async () => {
  const client = fakeClient([]);
  const runner = make('a b', client, fakeSave());
  await runner.start();
  await runner.start();
  assert.equal(client.sent.length, 4);
  assert.equal(runner.state.why.done, 2);
});

test('a reply that cannot be read ends stopped, keeps and saves the rest, and a later start works', async () => {
  const client = fakeClient([answer, answer, { answers: {} }]);
  const save = fakeSave();
  const runner = make('a b c d', client, save);
  await runner.start();
  assert.equal(runner.state.phase, 'stopped');
  assert.equal(typeof runner.state.error, 'string');
  assert.equal(runner.state.why.done, 2);
  assert.deepEqual(save.parts.map((p) => p.done), [2]);
  await runner.start();
  assert.equal(runner.state.phase, 'done');
  assert.equal(runner.state.why.done, 4);
});

test('a throwing listener does not leave the runner running', async () => {
  const runner = make('a b', fakeClient([]), fakeSave());
  runner.subscribe(() => {
    throw new Error('boom');
  });
  await runner.start();
  assert.equal(runner.state.phase, 'done');
});
