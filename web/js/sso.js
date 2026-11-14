import { HREF } from './routes.js';

// Single sign-on: what the sign-in page shows beside the password form.
// The server's callback returns to #/sign-in/<code> on failure; only these codes are ever shown.
export const SSO_ERRORS = {
  failed: 'Sign-in with the provider failed. Try again.',
  unreachable: 'The sign-in provider is not reachable. Try again later.',
  'no-account': 'No account for this sign-in. Ask an admin to add you.',
  limited: 'Too many attempts. Wait a minute and try again.',
};

export const ssoError = (code) => {
  if (code == null) return null;
  return Object.hasOwn(SSO_ERRORS, code) ? SSO_ERRORS[code] : SSO_ERRORS.failed;
};

// Where the link leads; `asked` is the route to return to after signing in. Silent asks the
// provider without showing it anything (prompt=none) and comes back either way.
export const ssoStartHref = (asked, { silent = false } = {}) =>
  `auth/oidc/start?next=${encodeURIComponent(asked ?? '')}${silent ? '&silent=1' : ''}`;

// The tab's one silent trip to the provider is remembered here; the value is the hash it asked for.
export const SSO_CHECKED = 'magicshell.sso-checked';

const isSignIn = (hash) => hash === HREF.signIn || hash.startsWith(`${HREF.signIn}/`);

// The href to leave for when this tab has not yet asked the provider whether someone is signed in
// there, else null. `#/sign-in/<code>` is a failed return and never asks again; the bare sign-in
// route is nothing asked, so Ask is the route to come back to.
export function silentCheck({ config, hash, session }) {
  if (config.mode !== 'accounts' || !config.sso || config.user || !session) return null;
  const at = hash ?? '';
  if (at.startsWith(`${HREF.signIn}/`)) return null;
  try {
    if (session.getItem(SSO_CHECKED) !== null) return null;
    const asked = at === '' || isSignIn(at) ? HREF.ask : at;
    session.setItem(SSO_CHECKED, asked);
    // Storage that cannot remember would send the tab round again and again.
    return session.getItem(SSO_CHECKED) === asked ? ssoStartHref(asked, { silent: true }) : null;
  } catch {
    return null;
  }
}

// The route the check was made for, so a password sign-in after it lands there.
export function askedAfterCheck(session) {
  try {
    const hash = session?.getItem(SSO_CHECKED);
    return typeof hash === 'string' && hash.startsWith('#/') && !isSignIn(hash) ? hash : null;
  } catch {
    return null;
  }
}

// Signing out must not bounce straight back in through the provider.
export function markChecked(session) {
  try {
    session?.setItem(SSO_CHECKED, HREF.ask);
  } catch {
    // Nothing to remember it with; the next load may check once.
  }
}

// Password changes belong to accounts that have a password here.
export const canChangePassword = (ctx) => ctx.mode === 'accounts' && Boolean(ctx.user?.password);
