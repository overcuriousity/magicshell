import assert from 'node:assert/strict';
import test from 'node:test';

// A sessionStorage that has filled up: reads and removals work, writes throw.
const fullStorage = (seed) => {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: (k) => data.delete(k),
  };
};

test('forgetting drafts reaches a session storage that is full', async () => {
  const real = fullStorage({ 'magicshell.bench': '{"a":{}}', 'magicshell.guided': '{}', other: 'x' });
  globalThis.sessionStorage = real;
  const { forget, sessionStore } = await import('./session.js');
  const stand = sessionStore();
  assert.notEqual(stand, real);
  stand.setItem('magicshell.guided', 'in memory');
  forget(['magicshell.bench', 'magicshell.guided']);
  assert.equal(real.data.has('magicshell.bench'), false);
  assert.equal(real.data.has('magicshell.guided'), false);
  assert.equal(real.data.get('other'), 'x');
  assert.equal(stand.getItem('magicshell.guided'), null);
  delete globalThis.sessionStorage;
});
