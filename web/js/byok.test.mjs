import assert from 'node:assert/strict';
import test from 'node:test';
import { applyByok, BYOK_KEY, loadByok, saveByok } from './byok.js';

const memory = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

test('byok values round trip', () => {
  const storage = memory();
  assert.equal(loadByok(storage), null);
  assert.equal(saveByok(storage, { endpoint: ' https://h.example/v1/systemone ', key: 'k-1', model: ' m1 ' }), null);
  assert.deepEqual(loadByok(storage), { endpoint: 'https://h.example/v1', key: 'k-1', model: 'm1' });
  assert.ok(storage.m.has(BYOK_KEY));
});

test('an endpoint without https is refused', () => {
  const storage = memory();
  assert.equal(
    saveByok(storage, { endpoint: 'http://h.example/v1', key: 'k', model: 'm1' }),
    'Use an https address, or http://localhost for a model on this machine.',
  );
  assert.equal(loadByok(storage), null);
  assert.equal(saveByok(storage, { endpoint: 'http://localhost:8080/v1', key: '', model: 'm1' }), null);
});

test('a missing model is refused', () => {
  const storage = memory();
  assert.equal(saveByok(storage, { endpoint: 'https://h.example/v1', key: 'k', model: '   ' }), 'Name the model to ask.');
  assert.equal(loadByok(storage), null);
});

test('an empty key is allowed', () => {
  const storage = memory();
  assert.equal(saveByok(storage, { endpoint: 'https://h.example/v1', key: '', model: 'm1' }), null);
  assert.deepEqual(loadByok(storage), { endpoint: 'https://h.example/v1', key: '', model: 'm1' });
});

test('unreadable or blocked storage counts as none', () => {
  assert.equal(loadByok(null), null);
  assert.equal(loadByok({ getItem: () => '{nope' }), null);
  assert.equal(loadByok({ getItem: () => { throw new Error('blocked'); } }), null);
});

test('a refused write keeps the new values in use and says they were not kept', () => {
  const old = memory();
  saveByok(old, { endpoint: 'https://old.example/v1', key: 'k0', model: 'old' });
  const full = { getItem: old.getItem, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
  assert.deepEqual(applyByok(full, { endpoint: 'https://new.example/v1/', key: 'k1', model: 'new' }), {
    value: { endpoint: 'https://new.example/v1', key: 'k1', model: 'new' },
    kept: false,
  });
  assert.deepEqual(applyByok(old, { endpoint: 'https://new.example/v1', key: '', model: 'new' }), {
    value: { endpoint: 'https://new.example/v1', key: '', model: 'new' },
    kept: true,
  });
  assert.deepEqual(applyByok(null, { endpoint: 'https://new.example/v1', key: '', model: 'new' }).kept, false);
  assert.deepEqual(applyByok(old, { endpoint: 'https://new.example/v1', key: '', model: '' }), { error: 'Name the model to ask.' });
});
