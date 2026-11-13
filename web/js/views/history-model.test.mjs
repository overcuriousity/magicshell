import assert from 'node:assert/strict';
import test from 'node:test';
import { benchResult, createHistoryModel, formatWhen, headline } from './history-model.js';

const memoryStore = (entries = []) => {
  let list = entries.map((e) => structuredClone(e));
  return {
    async listHistory() { return structuredClone(list).sort((a, b) => b.at.localeCompare(a.at)); },
    async saveEntry(e) { list = [...list.filter((x) => x.id !== e.id), structuredClone(e)]; },
    async deleteEntry(id) { list = list.filter((e) => e.id !== id); },
    async clearHistory() { list = []; },
  };
};

const entry = (id, at, extra = {}) => ({
  id,
  at,
  guided: true,
  run: { state: 'Printer is on fire', questions: [{ key: 'q1', type: 'noul', text: 'Is it urgent?' }] },
  reply: { answers: { q1: { type: 'noul', noul: 0.8 } }, model: 'm', inputTokens: 9, upstreamMs: 100, request: '{}', response: '{}' },
  totalMs: 250,
  ...extra,
});

const three = () => [entry('a', '2026-11-10T10:00:00Z'), entry('b', '2026-11-11T10:00:00Z'), entry('c', '2026-11-12T10:00:00Z')];

test('a removed entry comes back on undo', async () => {
  const m = createHistoryModel(memoryStore(three()));
  await m.load();
  const undo = await m.remove('b');
  assert.deepEqual(m.entries().map((e) => e.id), ['c', 'a']);
  await undo();
  assert.deepEqual(m.entries().map((e) => e.id), ['c', 'b', 'a']);
});

test('clearing removes everything and undo restores it in order', async () => {
  const m = createHistoryModel(memoryStore(three()));
  await m.load();
  const before = m.entries();
  const undo = await m.clear();
  assert.equal(m.entries().length, 0);
  await undo();
  assert.deepEqual(m.entries(), before);
});

test('subscribers hear about changes', async () => {
  const m = createHistoryModel(memoryStore(three()));
  let n = 0;
  m.subscribe(() => { n += 1; });
  await m.load();
  await m.remove('a');
  assert.equal(n, 2);
});

test('the headline of a triage run is its first question and pick', () => {
  const run = {
    state: 's',
    questions: [
      { key: 'urgency', type: 'choice', text: 'How urgent?', options: [{ name: 'low' }, { name: 'high ' }] },
      { key: 'x', type: 'noul', text: 'More?' },
    ],
  };
  const reply = { answers: { urgency: { type: 'choice', choice: 'high', probabilities: [0.2, 0.8], confidence: 0.7 }, x: { type: 'noul', noul: 0.1 } } };
  assert.deepEqual(headline({ run, reply, guided: false }), { text: 'How urgent?', answer: 'high', cls: 'opt-2' });
});

test('the headline falls back to the situation and names Yes, No and levels', () => {
  const noText = entry('a', '2026-11-12T10:00:00Z', { run: { state: 'A leak', questions: [{ key: 'q1', type: 'noul', text: '' }] } });
  assert.deepEqual(headline(noText), { text: 'A leak', answer: 'Yes', cls: 'ms-accent' });
  const score = (guided) => ({
    guided,
    run: { state: '', questions: [{ key: 'q1', type: 'score', text: 'Mood?', levels: [{ text: 'bad' }, { text: 'ok' }, { text: 'good' }] }] },
    reply: { answers: { q1: { type: 'score', score: 2.2, probabilities: [0, 0, 1], confidence: 0.5 } } },
  });
  assert.equal(headline(score(true)).answer, 'good');
  assert.equal(headline(score(false)).answer, '2.2 · good');
});

test('benchResult puts the latency into the reply', () => {
  const r = benchResult(entry('a', '2026-11-12T10:00:00Z'));
  assert.equal(r.totalMs, 250);
  assert.equal(r.inputTokens, 9);
});

test('formatWhen shows the time today, the day this year and the year before', () => {
  const now = new Date(2026, 10, 13, 18, 0);
  const at = (y, mo, d, h = 14, mi = 2) => new Date(y, mo, d, h, mi).toISOString();
  assert.equal(formatWhen(at(2026, 10, 13), now), '14:02');
  assert.equal(formatWhen(at(2026, 10, 12), now), '12 Nov');
  assert.equal(formatWhen(at(2025, 10, 12), now), '12 Nov 2025');
  assert.equal(formatWhen(at(2026, 10, 13, 9, 5), now), '09:05');
});

test('an entry without a request shows the run as the server client sends it', () => {
  const e = entry('a', '2026-11-12T10:00:00Z');
  assert.equal(benchResult(e).request, '{}');
  delete e.reply.request;
  e.run = { state: 'Rain.', questions: [{ key: 'q1', type: 'noul', text: 'Wet?' }] };
  assert.equal(benchResult(e).request, '{"state":"Rain.","questions":[{"key":"q1","type":"noul","text":"Wet?"}]}');
});
