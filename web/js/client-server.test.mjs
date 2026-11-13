import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerClient, RunError } from './client-server.js';

const run = {
  state: 'A cat.',
  model: 'sneaky',
  key: 'secret',
  questions: [
    {
      key: 'pet',
      type: 'choice',
      text: 'Which?',
      ui: 'x',
      options: [
        { id: 'o1', name: 'cat', description: '', open: true },
        { id: 'o2', name: 'dog', description: 'd' },
      ],
    },
    { key: 'n', type: 'score', text: 'How?', levels: [{ id: 'l1', text: 'a' }, { id: 'l2', text: 'b' }] },
  ],
};
const GOOD_ANSWERS = {
  pet: { type: 'choice', choice: 'cat', probabilities: [0.7, 0.3], confidence: 0.5 },
  n: { type: 'score', score: 0.5, probabilities: [0.4, 0.6], confidence: 0.5 },
};
const reply = (status, text) => ({ status, ok: status >= 200 && status < 300, text: async () => text });
const stub = (status, text, seen = []) => async (url, init) => {
  seen.push({ url, init });
  return reply(status, text);
};
const fails = (promise, kind, message) =>
  assert.rejects(promise, (e) => e instanceof RunError && e.kind === kind && (message === undefined || e.message === message));

test('the server client turns a 401 into an auth error', async () => {
  await fails(createServerClient(stub(401, 'Sign in first.')).run(run), 'auth', 'Sign in first.');
});

test('the server client never sends a model or a key', async () => {
  const seen = [];
  const body = JSON.stringify({ answers: GOOD_ANSWERS, model: 'm', inputTokens: 7, upstreamMs: 321 });
  const result = await createServerClient(stub(200, body, seen)).run(run);
  assert.equal(seen[0].url, 'api/run');
  const sent = JSON.parse(seen[0].init.body);
  assert.deepEqual(Object.keys(sent), ['state', 'questions']);
  assert.equal(seen[0].init.body.includes('sneaky'), false);
  assert.equal(seen[0].init.body.includes('secret'), false);
  assert.deepEqual(sent.questions[0].options[0], { id: 'o1', name: 'cat', description: '' });
  assert.equal('ui' in sent.questions[0], false);
  assert.deepEqual(sent.questions[1].levels[0], { id: 'l1', text: 'a' });
  assert.equal(result.request, seen[0].init.body);
  assert.equal(result.response, body);
  assert.equal(result.upstreamMs, 321);
  assert.equal(result.inputTokens, 7);
});

test('status codes map to kinds with the server sentence', async () => {
  const map = [[413, 'validation'], [422, 'validation'], [429, 'limit'], [502, 'upstream'], [504, 'upstream']];
  for (const [status, kind] of map) await fails(createServerClient(stub(status, 'One sentence.')).run(run), kind, 'One sentence.');
  await fails(createServerClient(stub(502, '')).run(run), 'upstream', 'The server answered with an error (502). Try again later.');
  await fails(createServerClient(stub(404, '<html>x</html>')).run(run), 'upstream', 'The server answered with an error (404). Try again later.');
});

test('a network failure says the server cannot be reached', async () => {
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  await fails(createServerClient(down).run(run), 'network', 'The server cannot be reached. Check your connection and try again.');
});

test('sign in, sign out and change password resolve on 204', async () => {
  const seen = [];
  const client = createServerClient(stub(204, '', seen));
  await client.signIn('ada', 'pw');
  await client.signOut();
  await client.changePassword('old', 'new');
  assert.deepEqual(seen.map((s) => s.url), ['api/auth/sign-in', 'api/auth/sign-out', 'api/auth/password']);
  assert.deepEqual(JSON.parse(seen[0].init.body), { username: 'ada', password: 'pw' });
  assert.deepEqual(JSON.parse(seen[2].init.body), { current: 'old', new: 'new' });
});

test('account calls reject with the server sentence', async () => {
  await fails(createServerClient(stub(401, 'Wrong username or password.')).signIn('a', 'b'), 'auth', 'Wrong username or password.');
  await fails(createServerClient(stub(422, 'Use at least 12 characters.')).changePassword('a', 'b'), 'validation', 'Use at least 12 characters.');
});

test('a malformed 2xx reply is an upstream error with the shared sentence', async () => {
  const sentence = 'The model endpoint sent an answer this app does not understand.';
  const missing = { answers: { pet: GOOD_ANSWERS.pet }, model: 'm' };
  const short = { answers: { ...GOOD_ANSWERS, pet: { ...GOOD_ANSWERS.pet, probabilities: [1] } } };
  const bodies = ['null', '[]', '7', '{}', '{"answers":1}', 'not json', JSON.stringify(missing), JSON.stringify(short)];
  for (const text of bodies) await fails(createServerClient(stub(200, text)).run(run), 'upstream', sentence);
});
