import assert from 'node:assert/strict';
import test from 'node:test';
import { SSO_ERRORS, canChangePassword, ssoError, ssoStartHref } from './sso.js';

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

test('a password can be changed only where the app keeps passwords', () => {
  const user = { username: 'ada' };
  assert.equal(canChangePassword({ mode: 'accounts', user, sso: null }), true);
  assert.equal(canChangePassword({ mode: 'accounts', user, sso: { label: 'x' } }), false);
  assert.equal(canChangePassword({ mode: 'accounts', user: null, sso: null }), false);
  assert.equal(canChangePassword({ mode: 'open', user: null, sso: null }), false);
});
