import assert from 'node:assert/strict';
import test from 'node:test';
import { RunError } from './client-server.js';
import { createSimilarService } from './similar-store.js';
import { memoryVectorStore } from './vector-store.js';

const choice = (text, ...names) => ({
  key: 'q', type: 'choice', text, options: names.map((name, i) => ({ id: `o${i}`, name, description: '' })),
});
const score = (text, ...levels) => ({
  key: 'q', type: 'score', text, levels: levels.map((text, i) => ({ id: `l${i}`, text })),
});
const entry = (at, ...questions) => ({ id: at, at, run: { state: '', questions } });
const empty = { history: [], setups: [] };
const config = { id: 'c', min: 0.75, owner: 'open' };

function makeService(embed, data = empty, vectors = memoryVectorStore(), extra = {}) {
  return createSimilarService({
    client: { embed }, config, sources: async () => data, vectors, ...extra,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakeClock() {
  let time = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeoutFn(fn, delay) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { fn, at: time + delay, delay });
      return id;
    },
    clearTimeoutFn(id) {
      tasks.delete(id);
    },
    get delays() {
      return [...tasks.values()].map((task) => task.delay);
    },
    get size() {
      return tasks.size;
    },
    async advance(ms) {
      time += ms;
      const due = [...tasks.entries()].filter(([, task]) => task.at <= time);
      for (const [id] of due) tasks.delete(id);
      for (const [, task] of due) task.fn();
      await settle();
    },
  };
}

const vectorRecord = (questionKey, vector, configId = 'c') => ({
  key: `${configId}\0${questionKey}`,
  configId,
  questionKey,
  text: questionKey,
  vector,
  refused: vector === null,
});

test('a refused batch is split and a text refused alone is never sent again', async () => {
  const calls = [];
  const client = { async embed(texts) {
    calls.push(texts);
    if (texts.length > 1 || texts[0] === 'too long') {
      const error = new RunError('refused', 'validation');
      throw error;
    }
    return texts.map(() => [1, 0]);
  } };
  const data = {
    history: [{ id: 'd', at: '2026-11-01T00:00:00Z', run: { questions: [
      { type: 'choice', text: 'Dinner?', options: [{ name: 'pizza' }] },
    ] } }],
    setups: [],
  };
  const service = createSimilarService({ client, config: { id: 'c', min: 0.75, owner: 'open' }, sources: async () => data, vectors: memoryVectorStore() });
  await service.load('too long');
  assert.deepEqual(calls.slice(0, 3), [['too long', 'Dinner?'], ['too long'], ['Dinner?']]);
  await service.load('too long');
  assert.equal(calls.filter((texts) => texts.length === 1 && texts[0] === 'too long').length, 1);
});

test('the typed question is first and missing sources are newest-first in batches of at most 64', async () => {
  const history = Array.from({ length: 65 }, (_, i) => {
    const at = new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
    return entry(at, choice(`Question ${i}?`, `option ${i}`));
  });
  const calls = [];
  let changes = 0;
  const service = makeService(async (texts) => {
    calls.push(texts);
    return texts.map(() => [1, 0]);
  }, { history, setups: [] });
  await service.load('Typed?', () => { changes += 1; });
  assert.deepEqual(calls.map((batch) => batch.length), [64, 2]);
  assert.deepEqual(calls.flat(), ['Typed?', ...Array.from({ length: 65 }, (_, i) => `Question ${64 - i}?`)]);
  assert.equal(changes, 2);
});

test('request batches stay under the byte cap and contain only trimmed, cut embedding text', async () => {
  const long = `  ${'a'.repeat(2001)}  `;
  const history = Array.from({ length: 40 }, (_, i) => entry(
    `2026-11-01T00:00:${String(i).padStart(2, '0')}Z`,
    choice(`  ${i}-${'😀'.repeat(900)}  `, 'option'),
  ));
  const calls = [];
  const service = makeService(async (texts) => {
    calls.push(texts);
    return texts.map(() => [1, 0]);
  }, { history, setups: [] });
  await service.load(long);
  assert.ok(calls.length > 1);
  assert.equal(calls[0][0], 'a'.repeat(2000));
  for (const batch of calls) {
    assert.ok(new TextEncoder().encode(JSON.stringify({ texts: batch })).length <= 60 * 1024);
    for (const text of batch) {
      assert.equal(text, text.trim());
      assert.ok(text.length <= 2000);
    }
  }
});

test('vectors are normalized before saving and drive options and scales synchronously', async () => {
  const vectors = memoryVectorStore();
  const data = { history: [
    entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza', 'sushi')),
    entry('2026-11-02T00:00:00Z', score('Rating?', 'Low', 'High')),
  ], setups: [] };
  const service = makeService(async (texts) => texts.map(() => [3, 4]), data, vectors);
  await service.load('Query?');
  const records = await vectors.all();
  assert.equal(records.length, 3);
  for (const record of records) assert.deepEqual(record.vector, new Float32Array([0.6, 0.8]));
  assert.deepEqual(service.options('Query?', [' PIZZA ']), ['sushi']);
  assert.deepEqual(service.scales('Query?', []), [['Low', 'High']]);
  assert.deepEqual(service.scales('Query?', [' low ', 'HIGH']), []);
  assert.deepEqual(service.options('Another question?'), []);
});

test('zero vectors are saved as unusable refusals and are not requested again', async () => {
  const calls = [];
  const vectors = memoryVectorStore();
  const service = makeService(async (texts) => {
    calls.push(texts);
    return texts.map(() => [0, 0]);
  }, empty, vectors);
  await service.load('Query?');
  await service.load('Query?');
  assert.deepEqual(calls, [['Query?']]);
  assert.deepEqual(await vectors.all(), [{
    key: 'c\0query?', configId: 'c', questionKey: 'query?', text: 'Query?', vector: null, refused: true,
  }]);
  assert.deepEqual(service.options('Query?'), []);
});

test('unrelated, missing and refused vectors produce no offers', async () => {
  const vectors = memoryVectorStore();
  await vectors.claim(config.owner);
  await vectors.put(vectorRecord('unrelated?', new Float32Array([0, 1])));
  await vectors.put(vectorRecord('refused?', null));
  const data = { history: [
    entry('2026-11-01T00:00:00Z', choice('Unrelated?', 'no')),
    entry('2026-11-02T00:00:00Z', choice('Refused?', 'no')),
  ], setups: [] };
  const calls = [];
  const service = makeService(async (texts) => {
    calls.push(texts);
    return texts.map(() => [1, 0]);
  }, data, vectors);
  await service.load('Query?');
  assert.deepEqual(calls, [['Query?']]);
  assert.deepEqual(service.options('Query?'), []);
  assert.deepEqual(service.scales('Query?'), []);
});

test('initialization claims before reading and removes other configs and stale sources', async () => {
  const store = memoryVectorStore();
  await store.claim(config.owner);
  await store.put(vectorRecord('query?', new Float32Array([1, 0])));
  await store.put(vectorRecord('deleted?', new Float32Array([1, 0])));
  await store.put(vectorRecord('query?', new Float32Array([1, 0]), 'other'));
  const log = [];
  const vectors = {
    async claim(owner) { log.push(['claim', owner]); await store.claim(owner); },
    async all() { log.push(['all']); return store.all(); },
    async put(record) { return store.put(record); },
    async remove(keys) { return store.remove(keys); },
    async clear() { return store.clear(); },
  };
  let embeds = 0;
  const data = { history: [entry('2026-11-01T00:00:00Z', choice('Query?', 'yes'))], setups: [] };
  const service = makeService(async () => { embeds += 1; return [[1, 0]]; }, data, vectors);
  await service.load('Query?');
  assert.deepEqual(log.slice(0, 2), [['claim', 'open'], ['all']]);
  assert.equal(embeds, 0);
  assert.deepEqual((await store.all()).map((record) => record.key), ['c\0query?']);
  assert.deepEqual(service.options('Query?'), ['yes']);
});

test('network, limit and upstream failures persist nothing and retry once after 30 seconds', async (t) => {
  for (const [name, kind] of [['network', 'network'], ['429', 'limit'], ['502', 'upstream']]) {
    await t.test(name, async () => {
      const clock = fakeClock();
      const calls = [];
      const vectors = memoryVectorStore();
      const data = { history: [entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza'))], setups: [] };
      const service = makeService(async (texts) => {
        calls.push(texts);
        if (calls.length === 1) throw new RunError('try later', kind);
        return texts.map(() => [1, 0]);
      }, data, vectors, clock);
      await service.load('Query?');
      assert.equal(calls.length, 1);
      assert.deepEqual(await vectors.all(), []);
      assert.deepEqual(clock.delays, [30000]);
      await service.load('Query?');
      await clock.advance(29999);
      assert.equal(calls.length, 1);
      await clock.advance(1);
      assert.equal(calls.length, 2);
      assert.equal((await vectors.all()).length, 2);
      assert.equal(clock.size, 0);
    });
  }
});

test('a failed retry is not scheduled again', async () => {
  const clock = fakeClock();
  let calls = 0;
  const service = makeService(async () => {
    calls += 1;
    throw new RunError('down', 'network');
  }, empty, memoryVectorStore(), clock);
  await service.load('Query?');
  await clock.advance(30000);
  assert.equal(calls, 2);
  assert.equal(clock.size, 0);
});

test('deleting a source prunes its offers immediately and removes its persistent record', async () => {
  const vectors = memoryVectorStore();
  const data = { history: [entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza'))], setups: [] };
  const service = makeService(async (texts) => texts.map(() => [1, 0]), data, vectors);
  let changes = 0;
  await service.load('Query?', () => { changes += 1; });
  assert.deepEqual(service.options('Query?'), ['pizza']);
  assert.equal(changes, 1);
  service.update(empty);
  assert.deepEqual(service.options('Query?'), []);
  assert.equal(changes, 2);
  await settle();
  assert.deepEqual((await vectors.all()).map((record) => record.questionKey), ['query?']);
});

test('an old response cannot reinsert a deleted source', async () => {
  const pending = deferred();
  const vectors = memoryVectorStore();
  const data = { history: [entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza'))], setups: [] };
  const service = makeService(() => pending.promise, data, vectors);
  const loading = service.load('Query?');
  await settle();
  service.update(empty);
  pending.resolve([[1, 0], [1, 0]]);
  await loading;
  assert.deepEqual((await vectors.all()).map((record) => record.questionKey), ['query?']);
  assert.deepEqual(service.options('Query?'), []);
});

test('an old typed answer and its callback are dropped after loading a new question', async () => {
  const old = deferred();
  const current = deferred();
  const vectors = memoryVectorStore();
  const calls = [];
  const service = makeService((texts) => {
    calls.push(texts);
    return texts[0] === 'Old?' ? old.promise : current.promise;
  }, empty, vectors);
  let oldChanges = 0;
  let currentChanges = 0;
  const oldLoad = service.load('Old?', () => { oldChanges += 1; });
  await settle();
  const currentLoad = service.load('New?', () => { currentChanges += 1; });
  old.resolve([[1, 0]]);
  await settle();
  current.resolve([[0, 1]]);
  await Promise.all([oldLoad, currentLoad]);
  assert.deepEqual(calls, [['Old?'], ['New?']]);
  assert.equal(oldChanges, 0);
  assert.equal(currentChanges, 1);
  assert.deepEqual((await vectors.all()).map((record) => record.questionKey), ['new?']);
});

test('a superseded refusal split stops before requesting remaining old sources', async () => {
  const pending = deferred();
  const calls = [];
  const data = { history: [entry(
    '2026-11-01T00:00:00Z',
    choice('One?', 'one'),
    choice('Two?', 'two'),
    choice('Three?', 'three'),
  )], setups: [] };
  const service = makeService(async (texts) => {
    calls.push(texts);
    if (texts.length > 1 && texts[0] === 'Old?') throw new RunError('refused', 'validation');
    if (texts.length === 1 && texts[0] === 'One?' && calls.length === 3) return pending.promise;
    return texts.map(() => [1, 0]);
  }, data);
  const oldLoad = service.load('Old?');
  await settle();
  const newLoad = service.load('New?');
  pending.resolve([[1, 0]]);
  await Promise.all([oldLoad, newLoad]);
  assert.deepEqual(calls, [
    ['Old?', 'One?', 'Two?', 'Three?'],
    ['Old?'],
    ['One?'],
    ['New?', 'One?', 'Two?', 'Three?'],
  ]);
});

test('concurrent loads of one question do not duplicate network work', async () => {
  const pending = deferred();
  let calls = 0;
  const service = makeService(() => {
    calls += 1;
    return pending.promise;
  });
  const first = service.load('Query?');
  const second = service.load('Query?');
  await settle();
  assert.equal(calls, 1);
  pending.resolve([[1, 0]]);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('update backfills new sources only while a question is active', async () => {
  const calls = [];
  const embed = async (texts) => {
    calls.push(texts);
    return texts.map(() => [1, 0]);
  };
  const inactive = makeService(embed);
  inactive.update({ history: [entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza'))], setups: [] });
  await settle();
  assert.deepEqual(calls, []);

  const active = makeService(embed);
  await active.load('Query?');
  active.update({ history: [entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza'))], setups: [] });
  await settle();
  assert.deepEqual(calls, [['Query?'], ['Dinner?']]);
  assert.deepEqual(active.options('Query?'), ['pizza']);
});

test('clear empties memory and persistent records without an extra notification', async () => {
  const vectors = memoryVectorStore();
  const service = makeService(async (texts) => texts.map(() => [1, 0]), {
    history: [entry('2026-11-01T00:00:00Z', choice('Dinner?', 'pizza'))], setups: [],
  }, vectors);
  let changes = 0;
  await service.load('Query?', () => { changes += 1; });
  assert.equal((await vectors.all()).length, 2);
  await service.clear();
  assert.deepEqual(await vectors.all(), []);
  assert.deepEqual(service.options('Query?'), []);
  assert.equal(changes, 1);
});

test('clear invalidates a pending response and its callback', async () => {
  const pending = deferred();
  const vectors = memoryVectorStore();
  const service = makeService(() => pending.promise, empty, vectors);
  let changes = 0;
  const loading = service.load('Query?', () => { changes += 1; });
  await settle();
  await service.clear();
  pending.resolve([[1, 0]]);
  await loading;
  assert.deepEqual(await vectors.all(), []);
  assert.equal(changes, 0);
});

test('a load after clear claims the cleared store again', async () => {
  const store = memoryVectorStore();
  const claims = [];
  const vectors = {
    async claim(owner) { claims.push(owner); await store.claim(owner); },
    all: () => store.all(),
    put: (record) => store.put(record),
    remove: (keys) => store.remove(keys),
    clear: () => store.clear(),
  };
  const service = makeService(async (texts) => texts.map(() => [1, 0]), empty, vectors);
  await service.load('Query?');
  await service.clear();
  await service.load('Query?');
  assert.deepEqual(claims, ['open', 'open']);
  assert.equal((await store.all()).length, 1);
});

test('load never rejects when source loading fails', async () => {
  const service = createSimilarService({
    client: { async embed() { return [[1, 0]]; } },
    config,
    sources: async () => { throw new Error('storage unavailable'); },
    vectors: memoryVectorStore(),
  });
  await assert.doesNotReject(service.load('Query?'));
  assert.deepEqual(service.options('Query?'), []);
});
