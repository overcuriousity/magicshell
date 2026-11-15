import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerClient, requestText, RunError } from './client-server.js';

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

test('only the server\'s own sentence is shown; a proxy\'s body is replaced', async () => {
  const { serverSentence } = await import('./run-error.js');
  const fallback = 'The server answered with an error (502). Try again later.';
  assert.equal(serverSentence('The model endpoint cannot be reached. Try again later.', 502), 'The model endpoint cannot be reached. Try again later.');
  for (const body of ['', '<html>Bad Gateway</html>', '{"error":"upstream"}', 'Bad Gateway', 'line one.\nline two.', `${'x'.repeat(400)}.`]) {
    assert.equal(serverSentence(body, 502), fallback, body);
  }
});

test('why posts the run to api/why and returns what run returns', async () => {
  const body = JSON.stringify({ answers: GOOD_ANSWERS, model: 'm', inputTokens: 7, upstreamMs: 321 });
  const seenRun = [];
  const seenWhy = [];
  const viaRun = await createServerClient(stub(200, body, seenRun), () => 0).run(run);
  const viaWhy = await createServerClient(stub(200, body, seenWhy), () => 0).why(run);
  assert.equal(seenWhy[0].url, 'api/why');
  assert.equal(seenWhy[0].init.body, seenRun[0].init.body);
  assert.deepEqual(viaWhy, viaRun);
});

test('why maps 429 to kind limit and 401 to auth', async () => {
  await fails(createServerClient(stub(429, 'Slow down.')).why(run), 'limit', 'Slow down.');
  await fails(createServerClient(stub(401, 'Sign in first.')).why(run), 'auth', 'Sign in first.');
});

test('preheat posts without a body and never rejects', async () => {
  const seen = [];
  assert.equal(await createServerClient(stub(204, '', seen)).preheat(), undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'api/preheat');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.body, undefined);
  for (const status of [401, 404, 500]) assert.equal(await createServerClient(stub(status, 'No.')).preheat(), undefined);
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(await createServerClient(down).preheat(), undefined);
});

const jpeg = (bytes) => `data:image/jpeg;base64,/9j/${'A'.repeat((Math.ceil(bytes / 3) - 1) * 4)}`;
const picture = (id, bytes) => ({ id, url: jpeg(bytes), width: 768, height: 576, bytes, preview: 'data:image/jpeg;base64,/9j/AA==' });
const OK_BODY = JSON.stringify({ answers: GOOD_ANSWERS, model: 'm', inputTokens: 7, upstreamMs: 1 });

test('a run with pictures sends images and no pictures field', async () => {
  const seen = [];
  const pictures = [picture('a', 3000), picture('b', 6000)];
  await createServerClient(stub(200, OK_BODY, seen)).run({ ...run, pictures });
  const sent = JSON.parse(seen[0].init.body);
  assert.deepEqual(Object.keys(sent), ['state', 'images', 'questions']);
  assert.deepEqual(sent.images, pictures.map((p) => p.url));
});

test('a run without pictures sends what it sent before', async () => {
  const seen = [];
  const plain = { state: 'Rain.', questions: [{ key: 'q1', type: 'noul', text: 'Wet?' }] };
  const body = JSON.stringify({ answers: { q1: { type: 'noul', noul: 0.5 } } });
  const client = createServerClient(stub(200, body, seen));
  await client.run(plain);
  await client.run({ ...plain, pictures: [] });
  const expected = '{"state":"Rain.","questions":[{"key":"q1","type":"noul","text":"Wet?"}]}';
  assert.deepEqual(seen.map((s) => s.init.body), [expected, expected]);
});

test('the request text shortens pictures', async () => {
  const seen = [];
  const result = await createServerClient(stub(200, OK_BODY, seen)).run({ ...run, pictures: [picture('a', 84 * 1024)] });
  assert.deepEqual(JSON.parse(result.request).images, ['data:image/jpeg;base64,…(84 KB)']);
  assert.ok(seen[0].init.body.length > 100 * 1024);
  assert.equal(requestText({ ...run, pictures: [{ bytes: 2048 }] }).includes('"images":["data:image/jpeg;base64,…(2 KB)"]'), true);
});

test('stopping the call rejects as stopped, not as a network failure', async () => {
  const controller = new AbortController();
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const pending = createServerClient(hanging).run(run, { signal: controller.signal });
  controller.abort();
  await fails(pending, 'stopped');
});

test('a run over maxBytes is refused before sending', async () => {
  const seen = [];
  const big = { ...run, state: 'x'.repeat(1024 * 1024) };
  await fails(createServerClient(stub(200, '{}', seen), undefined, { maxBytes: 1024 * 1024 }).run(big), 'validation', 'This run is too large for this server (1 MB).');
  assert.equal(seen.length, 0);
});

test('the longest refusal the server sends is shown, not replaced', async () => {
  const { serverSentence } = await import('./run-error.js');
  const prefix = 'The model endpoint refused this run: ';
  const refusal = `${prefix}${'ä'.repeat(300 - prefix.length - 2)}….`;
  assert.equal(refusal.length, 300);
  assert.equal(serverSentence(refusal, 502), refusal);
});

test('embed posts only texts to api/embed and returns the vectors', async () => {
  const seen = [];
  const client = createServerClient(stub(200, '{"vectors":[[0.25,1],[0,0.5]]}', seen));
  assert.deepEqual(await client.embed(['First?', 'Second?']), [[0.25, 1], [0, 0.5]]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'api/embed');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].init.body), { texts: ['First?', 'Second?'] });
  assert.equal(seen[0].init.body, '{"texts":["First?","Second?"]}');
});

test('embed maps HTTP and network failures to the existing error kinds', async () => {
  const map = [[401, 'auth'], [413, 'validation'], [422, 'validation'], [429, 'limit'], [502, 'upstream'], [404, 'upstream']];
  for (const [status, kind] of map) {
    await fails(createServerClient(stub(status, 'One sentence.')).embed(['Q?']), kind, 'One sentence.');
  }
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  await fails(createServerClient(down).embed(['Q?']), 'network');
});

test('embed rejects malformed successful replies as upstream errors', async () => {
  const bodies = [
    'not json',
    'null',
    '{}',
    '{"vectors":null}',
    '{"vectors":[1]}',
    '{"vectors":[[1,"2"]]}',
    '{"vectors":[[1,null]]}',
  ];
  for (const body of bodies) {
    await fails(createServerClient(stub(200, body)).embed(['Q?']), 'upstream');
  }
});
