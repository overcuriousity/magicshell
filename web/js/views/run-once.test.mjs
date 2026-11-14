import assert from 'node:assert/strict';
import test from 'node:test';
import { RunError } from '../run-error.js';
import { createRunOnce } from './run-once.js';

const run = () => ({ state: 'Rain.', questions: [{ key: 'q1', type: 'noul', text: 'Wet?' }] });
const result = (noul = 0.5) => ({ answers: { q1: { type: 'noul', noul } }, model: 'm', inputTokens: 1, upstreamMs: 1, totalMs: 2, request: '{}', response: '{}' });
const jpeg = 'data:image/jpeg;base64,/9j/AAAA';
const picture = (preview = jpeg) => ({ id: 'p1', url: jpeg, width: 768, height: 576, bytes: 5, preview });

// A client whose calls are settled by the test; it records the signal it was given.
function manualClient() {
  const calls = [];
  return {
    calls,
    run: (r, opts = {}) => new Promise((resolve, reject) => calls.push({ run: r, signal: opts.signal, resolve, reject })),
  };
}

function setup({ client = manualClient(), saveEntry } = {}) {
  const saved = [];
  const store = { saveEntry: saveEntry ?? (async (e) => void saved.push(structuredClone(e))) };
  let n = 0;
  const runner = createRunOnce({ client, store, now: () => new Date('2026-11-14T10:00:00Z'), uuid: () => `id${++n}`, mode: 'open', navigate() {}, guided: false });
  const log = [];
  const hooks = {
    start: () => log.push('start'),
    done: (r) => log.push(['done', r.answers.q1.noul]),
    fail: (s) => log.push(['fail', s]),
    saved: (e) => log.push(['saved', e.id]),
    stopped: () => log.push('stopped'),
  };
  return { client, runner, saved, log, hooks };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a run is asked once and its entry is saved', async () => {
  const s = setup();
  const sent = s.runner.send(run(), s.hooks);
  assert.equal(s.runner.busy, true);
  s.client.calls[0].resolve(result(0.9));
  await sent;
  assert.deepEqual(s.log, ['start', ['done', 0.9], ['saved', 'id1']]);
  assert.deepEqual(s.saved[0].run, run());
  assert.equal('pictures' in s.saved[0], false);
});

test('stop ends the call without a result or an entry', async () => {
  const s = setup();
  const sent = s.runner.send(run(), s.hooks);
  s.runner.stop();
  assert.equal(s.client.calls[0].signal.aborted, true);
  assert.equal(s.runner.busy, false);
  s.client.calls[0].reject(new RunError('', 'stopped'));
  await sent;
  assert.deepEqual(s.log, ['start', 'stopped']);
  assert.deepEqual(s.saved, []);
});

test('a late answer after stop is ignored and the next ask works', async () => {
  const s = setup();
  const first = s.runner.send(run(), s.hooks);
  s.runner.stop();
  const second = s.runner.send(run(), s.hooks);
  s.client.calls[0].resolve(result(0.1));
  await first;
  await settle();
  assert.deepEqual(s.log, ['start', 'stopped', 'start']);
  s.client.calls[1].resolve(result(0.7));
  await second;
  assert.deepEqual(s.log, ['start', 'stopped', 'start', ['done', 0.7], ['saved', 'id1']]);
  assert.equal(s.saved.length, 1);
});

test('stop without a call in flight does nothing', () => {
  const s = setup();
  s.runner.stop();
  assert.deepEqual(s.log, []);
});

test('a run with a bad picture is refused before it is sent', async () => {
  const s = setup();
  await s.runner.send({ ...run(), pictures: [{ ...picture(), url: 'data:image/png;base64,AAAA' }] }, s.hooks);
  assert.deepEqual(s.log, [['fail', 'A picture in this request cannot be read. Add it again.']]);
  assert.equal(s.client.calls.length, 0);
});

test('the entry keeps previews and not the pictures', async () => {
  const s = setup();
  const sent = s.runner.send({ ...run(), pictures: [picture(), picture(null)] }, s.hooks);
  assert.equal(s.client.calls[0].run.pictures.length, 2);
  s.client.calls[0].resolve(result());
  await sent;
  const [entry] = s.saved;
  assert.deepEqual(entry.run, run());
  assert.deepEqual(entry.pictures, [{ preview: jpeg, width: 768, height: 576, bytes: 5 }, { width: 768, height: 576, bytes: 5 }]);
  assert.equal(JSON.stringify(entry).includes('"url"'), false);
});

test('an entry that is too large is saved again without previews', async () => {
  const attempts = [];
  const saveEntry = async (e) => {
    attempts.push(structuredClone(e));
    if (e.pictures?.some((p) => p.preview)) throw new RunError('This request is too large. Shorten it and try again.', 'validation');
  };
  const s = setup({ saveEntry });
  const sent = s.runner.send({ ...run(), pictures: [picture()] }, s.hooks);
  s.client.calls[0].resolve(result());
  await sent;
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].pictures, [{ width: 768, height: 576, bytes: 5 }]);
  assert.deepEqual(s.log, ['start', ['done', 0.5], ['saved', 'id1']]);
});

test('a save that fails for another reason is reported once', async () => {
  let attempts = 0;
  const saveEntry = async () => {
    attempts += 1;
    throw new RunError('The server cannot be reached. Check your connection and try again.', 'network');
  };
  const s = setup({ saveEntry });
  const sent = s.runner.send({ ...run(), pictures: [picture()] }, s.hooks);
  s.client.calls[0].resolve(result());
  await sent;
  assert.equal(attempts, 1);
  assert.deepEqual(s.log.at(-1), ['fail', 'The server cannot be reached. Check your connection and try again.']);
});
