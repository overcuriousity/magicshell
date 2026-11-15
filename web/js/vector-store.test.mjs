import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryVectorStore, openVectorStore } from './vector-store.js';

const record = (questionKey = 'q') => ({
  key: `c\0${questionKey}`,
  configId: 'c',
  questionKey,
  text: 'Q',
  vector: new Float32Array([1]),
  refused: false,
});

function fakeIndexedDB({ upgradeFailures = 0, lateSuccess = false } = {}) {
  const records = new Map();
  const stores = new Set();
  let version = 0;
  let closeCalls = 0;
  const db = {
    close() {
      closeCalls += 1;
    },
    createObjectStore(name, options) {
      assert.equal(name, 'records');
      assert.deepEqual(options, { keyPath: 'key' });
      if (upgradeFailures > 0) {
        upgradeFailures -= 1;
        throw new Error('upgrade failed');
      }
      stores.add(name);
      return {};
    },
    transaction(name, mode) {
      assert.equal(name, 'records');
      let pending = 0;
      let completionScheduled = false;
      let finished = false;
      const tx = { mode };
      const complete = () => {
        if (pending || completionScheduled || finished) return;
        completionScheduled = true;
        setImmediate(() => {
          completionScheduled = false;
          if (pending || finished) return;
          finished = true;
          tx.oncomplete?.();
        });
      };
      const track = (operation) => {
        const request = {};
        pending += 1;
        queueMicrotask(() => {
          try {
            request.result = operation();
            request.onsuccess?.();
          } catch (error) {
            request.error = error;
            finished = true;
            request.onerror?.();
            tx.onerror?.();
            tx.onabort?.();
          } finally {
            pending -= 1;
            complete();
          }
        });
        return request;
      };
      tx.objectStore = (storeName) => {
        assert.equal(storeName, 'records');
        assert.ok(stores.has(storeName));
        return {
          get: (key) => track(() => structuredClone(records.get(key))),
          getAll: () => track(() => structuredClone([...records.values()])),
          put: (value) => track(() => {
            records.set(value.key, structuredClone(value));
            return value.key;
          }),
          delete: (key) => track(() => records.delete(key)),
          clear: () => track(() => records.clear()),
        };
      };
      queueMicrotask(complete);
      return tx;
    },
  };
  return {
    get closeCalls() {
      return closeCalls;
    },
    open(name, requestedVersion) {
      assert.equal(name, 'magicshell-vectors');
      assert.equal(requestedVersion, 1);
      const request = {};
      queueMicrotask(() => {
        try {
          request.result = db;
          if (version < requestedVersion) {
            let aborted = false;
            request.transaction = { abort: () => { aborted = true; } };
            request.onupgradeneeded?.();
            if (!aborted) version = requestedVersion;
            else {
              request.error = new Error('upgrade aborted');
              request.onerror?.();
              if (!lateSuccess) return;
            }
          }
          request.onsuccess?.();
        } catch (error) {
          request.error = error;
          request.onerror?.();
        }
      });
      return request;
    },
  };
}

test('claim clears another owner before records can be read', async () => {
  const store = memoryVectorStore();
  await store.claim('alice');
  await store.put({ key: 'c\0q', configId: 'c', questionKey: 'q', text: 'Q', vector: new Float32Array([1]), refused: false });
  await store.claim('bob');
  assert.deepEqual(await store.all(), []);
});

test('the same owner keeps vectors and clear removes vectors and refusal markers', async () => {
  const store = memoryVectorStore();
  await store.claim('alice');
  await store.put({ key: 'c\0q', configId: 'c', questionKey: 'q', text: 'Q', vector: null, refused: true });
  await store.claim('alice');
  assert.equal((await store.all())[0].refused, true);
  await store.clear();
  assert.deepEqual(await store.all(), []);
});

test('no IndexedDB uses the in-memory adapter', async () => {
  const store = await openVectorStore(undefined);
  await store.claim('open');
  assert.deepEqual(await store.all(), []);
});

test('remove deletes only the requested keys', async () => {
  const store = memoryVectorStore();
  await store.claim('alice');
  await store.put(record('one'));
  await store.put(record('two'));
  await store.remove(['c\0one']);
  assert.deepEqual((await store.all()).map((item) => item.questionKey), ['two']);
});

test('memory records are structured clones on input and output', async () => {
  const store = memoryVectorStore();
  await store.claim('alice');
  const original = record();
  await store.put(original);
  original.text = 'changed outside';
  original.vector[0] = 2;
  const [first] = await store.all();
  first.text = 'changed result';
  first.vector[0] = 3;
  const [second] = await store.all();
  assert.equal(second.text, 'Q');
  assert.deepEqual(second.vector, new Float32Array([1]));
});

test('an IndexedDB open which throws uses the in-memory adapter', async () => {
  const indexedDB = { open() { throw new Error('denied'); } };
  const store = await openVectorStore(indexedDB);
  await store.claim('memory');
  await store.put(record());
  assert.equal((await store.all()).length, 1);
});

test('an IndexedDB open which errors uses the in-memory adapter', async () => {
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.error = new Error('denied');
        request.onerror?.();
      });
      return request;
    },
  };
  const store = await openVectorStore(indexedDB);
  await store.claim('memory');
  assert.deepEqual(await store.all(), []);
});

test('an IndexedDB upgrade failure uses the in-memory adapter', async () => {
  const indexedDB = {
    open() {
      const request = { result: { createObjectStore() { throw new Error('upgrade failed'); } } };
      queueMicrotask(() => {
        try {
          request.onupgradeneeded?.();
        } catch (error) {
          request.error = error;
          request.onerror?.();
        }
      });
      return request;
    },
  };
  const store = await openVectorStore(indexedDB);
  await store.claim('memory');
  assert.deepEqual(await store.all(), []);
});

test('a failed upgrade aborts and closes a late connection so reopening can succeed', async () => {
  const indexedDB = fakeIndexedDB({ upgradeFailures: 1, lateSuccess: true });
  const fallback = await openVectorStore(indexedDB);
  await fallback.claim('memory');
  await fallback.put(record());
  assert.deepEqual(await fallback.all(), [record()]);
  const reopened = await openVectorStore(indexedDB);
  await reopened.claim('alice');
  await reopened.put(record());
  assert.deepEqual(await reopened.all(), [record()]);
  assert.equal(indexedDB.closeCalls, 1);
});

test('IndexedDB keeps records for the same owner and clears them for a new owner', async () => {
  const indexedDB = fakeIndexedDB();
  const first = await openVectorStore(indexedDB);
  await first.claim('alice');
  await first.put(record());
  const reopened = await openVectorStore(indexedDB);
  await reopened.claim('alice');
  assert.deepEqual(await reopened.all(), [record()]);
  await reopened.claim('bob');
  assert.deepEqual(await reopened.all(), []);
});
