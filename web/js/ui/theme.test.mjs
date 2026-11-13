import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextSize, applyTheme, nextTheme, storedTextSize, storedTheme } from './theme.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const fakeRoot = () => ({ dataset: {} });

test('the theme cycles system, light, dark', () => {
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(nextTheme('anything'), 'light');
});

test('applyTheme sets the attribute and stores the choice', () => {
  const root = fakeRoot();
  const storage = memoryStorage();
  applyTheme('dark', { root, storage });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(storage.getItem('magicshell.theme'), 'dark');
  assert.equal(storedTheme(storage), 'dark');
  applyTheme('system', { root, storage });
  assert.equal(root.dataset.theme, undefined);
  assert.equal(storedTheme(storage), 'system');
});

test('applyTextSize toggles compact density', () => {
  const root = fakeRoot();
  const storage = memoryStorage();
  applyTextSize('compact', { root, storage });
  assert.equal(root.dataset.density, 'compact');
  assert.equal(storedTextSize(storage), 'compact');
  applyTextSize('default', { root, storage });
  assert.equal(root.dataset.density, undefined);
  assert.equal(storedTextSize(storage), 'default');
});

test('blocked storage falls back to the defaults', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(storedTheme(blocked), 'system');
  assert.equal(storedTextSize(blocked), 'default');
  const root = fakeRoot();
  applyTheme('light', { root, storage: blocked });
  assert.equal(root.dataset.theme, 'light');
});
