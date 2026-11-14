// Single sign-on: what the sign-in page shows instead of the password form.
// The server's callback returns to #/sign-in/<code> on failure; only these codes are ever shown.
export const SSO_ERRORS = {
  failed: 'Sign-in with the provider failed. Try again.',
  unreachable: 'The sign-in provider is not reachable. Try again later.',
  'no-account': 'No account for this sign-in. Ask an admin to add you.',
};

export const ssoError = (code) => {
  if (code == null) return null;
  return Object.hasOwn(SSO_ERRORS, code) ? SSO_ERRORS[code] : SSO_ERRORS.failed;
};

// Where the button leads; `asked` is the route to return to after signing in.
export const ssoStartHref = (asked) => `auth/oidc/start?next=${encodeURIComponent(asked ?? '')}`;

// Passwords are the provider's business under single sign-on.
export const canChangePassword = (ctx) => ctx.mode === 'accounts' && Boolean(ctx.user) && !ctx.sso;
