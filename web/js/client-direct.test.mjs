import assert from 'node:assert/strict';
import test from 'node:test';
import { createDirectClient, RunError } from './client-direct.js';
import { requestJson } from './systemone.js';

const run = {
  state: 'A cat.',
  questions: [{ key: 'pet', type: 'choice', text: 'Which?', options: [{ name: 'cat' }, { name: 'dog' }] }],
};
const good = JSON.stringify({
  model: 'm',
  usage: { input_tokens: 5 },
  answers: { pet: { type: 'choice', choice: 'cat', probabilities: { cat: 0.9, dog: 0.1 }, confidence: 0.8 } },
});
const config = { endpoint: 'https://h/v1', key: 'k-123', model: 'm' };
const stub = (status, text, seen = []) => async (url, init) => {
  seen.push({ url, init });
  return { status, text: async () => text };
};
const clock = () => {
  let t = 100;
  return () => (t += 25);
};
const fails = (promise, kind, message) =>
  assert.rejects(promise, (e) => e instanceof RunError && e.kind === kind && (message === undefined || e.message === message));

test('the direct client posts the exact request text to systemone', async () => {
  const seen = [];
  const result = await createDirectClient(config, stub(200, good, seen), clock()).run(run);
  assert.equal(seen[0].url, 'https://h/v1/systemone');
  assert.equal(seen[0].init.body, requestJson(run, 'm'));
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
  assert.equal(result.request, seen[0].init.body);
  assert.equal(result.response, good);
  assert.equal(result.answers.pet.choice, 'cat');
  assert.equal(result.inputTokens, 5);
  assert.equal(result.upstreamMs, null);
  assert.equal(result.totalMs, 25);
});

test('the direct client sends the key as a bearer token and omits the header without one', async () => {
  const seen = [];
  await createDirectClient(config, stub(200, good, seen)).run(run);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer k-123');
  await createDirectClient({ ...config, key: '' }, stub(200, good, seen)).run(run);
  assert.equal('Authorization' in seen[1].init.headers, false);
});

test('a blocked request names CORS', async () => {
  const blocked = async () => {
    throw new TypeError('Failed to fetch');
  };
  await fails(
    createDirectClient(config, blocked).run(run),
    'network',
    'The endpoint did not answer the browser. It may be unreachable or not allow cross-origin requests (CORS).',
  );
});

test('a 501 says the model is not a decision model', async () => {
  await fails(
    createDirectClient(config, stub(501, '')).run(run),
    'upstream',
    'This model is not a decision model. Check it in Settings.',
  );
  await fails(createDirectClient(config, stub(401, '')).run(run), 'upstream', 'The model endpoint refused the key. Check it in Settings.');
  await fails(createDirectClient(config, stub(404, '')).run(run), 'upstream', 'The model endpoint does not know this model. Check it in Settings.');
  await fails(createDirectClient(config, stub(500, '')).run(run), 'upstream', 'The model endpoint answered with an error (500). Try again later.');
});

test('an invalid run is refused before any request', async () => {
  const seen = [];
  await fails(createDirectClient(config, stub(200, good, seen)).run({ state: '', questions: [] }), 'validation', 'Add at least one question.');
  assert.equal(seen.length, 0);
});

test('an unreadable answer is an upstream error', async () => {
  await fails(
    createDirectClient(config, stub(200, 'nope')).run(run),
    'upstream',
    'The model endpoint sent an answer this app does not understand.',
  );
});

test('an aborted request reports a slow model', async () => {
  const slow = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await fails(createDirectClient(config, slow).run(run), 'upstream', 'The model took too long to answer. Try again.');
});

test('any other thrown error says the endpoint could not be read', async () => {
  const odd = async () => {
    throw new Error('boom');
  };
  await fails(createDirectClient(config, odd).run(run), 'network', 'The endpoint could not be read. Try again.');
});
