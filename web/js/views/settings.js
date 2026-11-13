// Settings: theme and text size in every mode; in accounts mode the signed-in name, a new password
// and signing out.
import { messageOf } from '../run-error.js';
import { HREF } from '../routes.js';
import { h } from '../ui/dom.js';
import { inlineError } from '../ui/notice.js';
import { applyTextSize, applyTheme, storedTextSize, storedTheme } from '../ui/theme.js';

// Sent when theme or text size change, so the top-bar toggles and this page agree.
export const LOOK_EVENT = 'ms-look';
export const NOT_SAVING = 'This browser is not saving anything. History is lost when you close the page.';

const THEME_CHOICES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const SIZE_CHOICES = [['default', 'Default'], ['compact', 'Compact']];

export const field = (id, label, input, hint) =>
  h('div', { class: 'oc-field' }, h('label', { for: id }, label), input, hint ? h('span', { class: 'ms-field-hint', id: `${id}-hint` }, hint) : null);

function segmented(name, legend, choices, current, onpick) {
  return h('fieldset', { class: 'ms-segmented' },
    h('legend', { class: 'oc-field__label' }, legend),
    h('div', { class: 'ms-segmented__group' },
      choices.map(([value, label]) =>
        h('label', {},
          h('input', { type: 'radio', name, value, checked: value === current, onchange: () => onpick(value) }),
          h('span', {}, label),
        ),
      ),
    ),
  );
}

// Busy forms ignore a second submit; the button shows it.
function busyForm(form, button, work) {
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    button.setAttribute('aria-disabled', 'true');
    try {
      await work();
    } finally {
      busy = false;
      button.removeAttribute('aria-disabled');
    }
  });
  return form;
}

export function createSettingsView() {
  let root = null;
  const sync = () => {
    if (!root) return;
    for (const [name, value] of [['theme', storedTheme()], ['textsize', storedTextSize()]]) {
      for (const input of root.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
    }
  };

  function look() {
    const changed = () => window.dispatchEvent(new CustomEvent(LOOK_EVENT));
    return h('section', { class: 'ms-settings__part', 'aria-labelledby': 'settings-look' },
      h('h2', { class: 'oc-text-section', id: 'settings-look' }, 'Look'),
      segmented('theme', 'Theme', THEME_CHOICES, storedTheme(), (v) => { applyTheme(v); changed(); }),
      segmented('textsize', 'Text size', SIZE_CHOICES, storedTextSize(), (v) => { applyTextSize(v); changed(); }),
    );
  }

  function account(ctx) {
    const name = ctx.user?.username ?? '';
    const current = h('input', { type: 'password', class: 'oc-input', id: 'pw-current', name: 'current', autocomplete: 'current-password', required: true });
    const next = h('input', { type: 'password', class: 'oc-input', id: 'pw-new', name: 'new', autocomplete: 'new-password', required: true, 'aria-describedby': 'pw-new-hint' });
    const error = h('div', { class: 'ms-error-host' });
    const change = h('button', { type: 'submit', class: 'oc-btn oc-btn--primary' }, 'Change password');
    const form = h('form', { class: 'oc-form', novalidate: true, 'aria-labelledby': 'settings-password' },
      // For password managers: which account the new password belongs to.
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: name, hidden: true, readonly: true, tabindex: '-1' }),
      field('pw-current', 'Current password', current),
      field('pw-new', 'New password', next, 'At least 12 characters'),
      error,
      h('div', { class: 'oc-form__actions' }, change),
    );
    busyForm(form, change, async () => {
      try {
        await ctx.client.changePassword(current.value, next.value);
      } catch (e) {
        error.replaceChildren(inlineError(messageOf(e)));
        if (e.kind === 'auth') ctx.navigate(HREF.signIn);
        return;
      }
      error.replaceChildren();
      current.value = '';
      next.value = '';
      ctx.notify('Password changed. Other sign-ins of this account are signed out.', { kind: 'success' });
    });
    const out = h('button', { type: 'button', class: 'oc-btn', onclick: async () => {
      try {
        await ctx.signOut();
      } catch (e) {
        ctx.notify(messageOf(e), { kind: 'danger' });
      }
    } }, 'Sign out');
    return h('section', { class: 'ms-settings__part', 'aria-labelledby': 'settings-account' },
      h('h2', { class: 'oc-text-section', id: 'settings-account' }, 'Account'),
      h('div', { class: 'ms-signed-in' }, h('span', { class: 'oc-field__label' }, 'Signed in as'), h('span', { class: 'ms-mono' }, name), out),
      h('h3', { class: 'ms-settings__sub', id: 'settings-password' }, 'Change password'),
      form,
    );
  }

  return {
    mount(el, ctx) {
      root = el;
      el.classList.add('ms-settings');
      el.append(...[
        h('header', { class: 'oc-page-head' }, h('h1', { class: 'oc-text-page', tabindex: '-1' }, 'Settings')),
        ctx.mode === 'accounts' && ctx.user ? account(ctx) : null,
        look(),
      ].filter(Boolean));
      window.addEventListener(LOOK_EVENT, sync);
    },
    unmount() {
      window.removeEventListener(LOOK_EVENT, sync);
      root = null;
    },
  };
}
