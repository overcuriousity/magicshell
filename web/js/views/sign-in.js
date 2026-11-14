// Sign in (accounts mode only): username and password; the server's sentence inline on failure.
// Under single sign-on a link to the provider sits under the form; after a failed return, why it failed.
// ctx.signIn resolves when the session holds and the app has moved on to the route asked for.
import { messageOf } from '../run-error.js';
import { h } from '../ui/dom.js';
import { inlineError } from '../ui/notice.js';
import { ssoError, ssoStartHref } from '../sso.js';
import { field } from './settings.js';

export function createSignInView() {
  return {
    mount(el, ctx) {
      el.classList.add('ms-sign-in');
      const username = h('input', { type: 'text', class: 'oc-input', id: 'sign-in-username', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
      const password = h('input', { type: 'password', class: 'oc-input', id: 'sign-in-password', name: 'password', autocomplete: 'current-password', required: true });
      // After a failed return from the provider, its sentence; later failures replace it.
      const failed = ssoError(ctx.route.id);
      const error = h('div', { class: 'ms-error-host' }, failed ? inlineError(failed) : null);
      const submit = h('button', { type: 'submit', class: 'oc-btn oc-btn--primary' }, 'Sign in');
      let busy = false;
      const form = h('form', { class: 'oc-form', novalidate: true, 'aria-labelledby': 'sign-in-title' },
        field('sign-in-username', 'Username', username),
        field('sign-in-password', 'Password', password),
        error,
        h('div', { class: 'oc-form__actions' }, submit),
      );
      // A link, not a form: the page's CSP lets forms post only to this server. Plain, so Sign in
      // stays the one primary button.
      const provider = ctx.sso ? h('a', { class: 'oc-btn', href: ssoStartHref(ctx.asked) }, ctx.sso.label) : null;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        busy = true;
        submit.setAttribute('aria-disabled', 'true');
        try {
          await ctx.signIn(username.value, password.value);
        } catch (err) {
          error.replaceChildren(inlineError(messageOf(err)));
          password.value = '';
          password.focus();
        } finally {
          busy = false;
          submit.removeAttribute('aria-disabled');
        }
      });
      el.append(
        h('header', { class: 'oc-page-head' }, h('h1', { class: 'oc-text-page', id: 'sign-in-title', tabindex: '-1' }, 'Sign in')),
        form,
      );
      // append would print a null as text.
      if (provider) el.append(h('div', { class: 'oc-form__actions' }, provider));
      username.focus({ preventScroll: true });
    },
    unmount() {},
  };
}
