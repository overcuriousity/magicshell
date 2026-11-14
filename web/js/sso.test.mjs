import assert from 'node:assert/strict';
import test from 'node:test';
import { SSO_ERRORS, SSO_CHECKED, askedAfterCheck, canChangePassword, markChecked, silentCheck, ssoError, ssoStartHref } from './sso.js';

test('each failure code has its sentence', () => {
  assert.equal(ssoError('failed'), 'Sign-in with the provider failed. Try again.');
  assert.equal(ssoError('unreachable'), 'The sign-in provider is not reachable. Try again later.');
  assert.equal(ssoError('no-account'), 'No account for this sign-in. Ask an admin to add you.');
});

test('an unknown code reads as a failed sign-in, never as text from the address', () => {
  for (const code of ['nonsense', '__proto__', 'constructor', '<b>x</b>', '']) {
    assert.equal(ssoError(code), SSO_ERRORS.failed, code);
  }
});

test('no code means no error', () => {
  assert.equal(ssoError(undefined), null);
  assert.equal(ssoError(null), null);
});

test('the button carries the route to return to', () => {
  assert.equal(ssoStartHref('#/history/a b'), 'auth/oidc/start?next=%23%2Fhistory%2Fa%20b');
  assert.equal(ssoStartHref(undefined), 'auth/oidc/start?next=');
});

test('the silent variant of the start link', () => {
  assert.equal(ssoStartHref('#/history', { silent: true }), 'auth/oidc/start?next=%23%2Fhistory&silent=1');
  assert.equal(ssoStartHref('#/history', { silent: false }), 'auth/oidc/start?next=%23%2Fhistory');
});

test('a password can be changed only where the app keeps passwords', () => {
  const sso = { label: 'x' };
  for (const withSso of [null, sso]) {
    assert.equal(canChangePassword({ mode: 'accounts', user: { username: 'ada', password: true }, sso: withSso }), true);
    assert.equal(canChangePassword({ mode: 'accounts', user: { username: 'ada', password: false }, sso: withSso }), false);
    assert.equal(canChangePassword({ mode: 'accounts', user: null, sso: withSso }), false);
  }
  assert.equal(canChangePassword({ mode: 'open', user: null, sso: null }), false);
});

const memorySession = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const signedOut = { mode: 'accounts', sso: { label: 'x' }, user: null };
const CHECK = 'auth/oidc/start?next=%23%2Fhistory&silent=1';

test('a signed-out single sign-on page makes one silent check and remembers what was asked', () => {
  const session = memorySession();
  assert.equal(silentCheck({ config: signedOut, hash: '#/history', session }), CHECK);
  assert.equal(session.getItem(SSO_CHECKED), '#/history');
  assert.equal(silentCheck({ config: signedOut, hash: '#/history', session }), null);
});

test('an empty hash or the bare sign-in route asks for Ask', () => {
  for (const hash of ['', '#/sign-in']) {
    const session = memorySession();
    assert.equal(silentCheck({ config: signedOut, hash, session }), 'auth/oidc/start?next=%23%2Fask&silent=1', hash);
    assert.equal(session.getItem(SSO_CHECKED), '#/ask');
  }
});

test('no silent check when signed in, open, without single sign-on, after a failure or without storage', () => {
  const hash = '#/history';
  const cases = [
    [{ ...signedOut, user: { username: 'ada', password: false } }, hash, memorySession()],
    [{ ...signedOut, mode: 'open' }, hash, memorySession()],
    [{ ...signedOut, sso: null }, hash, memorySession()],
    [signedOut, '#/sign-in/failed', memorySession()],
    [signedOut, hash, null],
    [signedOut, hash, { ...memorySession(), setItem() { throw new Error('full'); } }],
  ];
  for (const [config, h, session] of cases) assert.equal(silentCheck({ config, hash: h, session }), null);
});

test('no check after sign-out', () => {
  const session = memorySession();
  markChecked(session);
  assert.equal(session.getItem(SSO_CHECKED), '#/ask');
  assert.equal(silentCheck({ config: signedOut, hash: '#/history', session }), null);
  assert.doesNotThrow(() => markChecked({ setItem() { throw new Error('full'); } }));
  assert.doesNotThrow(() => markChecked(null));
});

test('after a check the route asked for comes back, never a sign-in route or a foreign address', () => {
  assert.equal(askedAfterCheck(memorySession({ [SSO_CHECKED]: '#/history' })), '#/history');
  for (const value of ['javascript:alert(1)', '#/sign-in', '#/sign-in/failed']) {
    assert.equal(askedAfterCheck(memorySession({ [SSO_CHECKED]: value })), null, value);
  }
  assert.equal(askedAfterCheck(memorySession()), null);
  assert.equal(askedAfterCheck(null), null);
});
