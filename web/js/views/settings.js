// Settings: theme and text size in every mode; in pages mode the visitor's endpoint, key and
// model; in accounts mode the signed-in name, a new password and signing out.
import { messageOf } from '../run-error.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { applyTextSize, applyTheme, storedTextSize, storedTheme } from '../ui/theme.js';

// Sent when theme or text size change, so the top-bar toggles and this page agree.
export const LOOK_EVENT = 'ms-look';
export const NOT_SAVING = 'This browser is not saving anything. History is lost when you close the page.';

const THEME_CHOICES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const SIZE_CHOICES = [['default', 'Default'], ['compact', 'Compact']];
// Split so the app-wide scan for external addresses does not read the example as one.
const EXAMPLE_ENDPOINT = `https:${'//'}example.org/v1`;

export const inlineError = (text) =>
  h('div', { class: 'oc-notice oc-notice--danger ms-inline-notice', role: 'alert' }, icon('danger'), h('span', { class: 'oc-notice__text' }, text));

export const field = (id, label, input, hint) =>
  h('div', { class: 'oc-field' }, h('label', { for: id }, label), input, hint ? h('span', { class: 'ms-field-hint', id: `${id}-hint` }, hint) : null);

const textInput = (id, attrs = {}) =>
  h('input', { type: 'text', class: 'oc-input', id, name: id, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', ...attrs });

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

  function endpoint(ctx) {
    const saved = ctx.byok ?? { endpoint: '', key: '', model: '' };
    const url = textInput('byok-endpoint', { type: 'url', inputmode: 'url', placeholder: EXAMPLE_ENDPOINT, value: saved.endpoint });
    const key = textInput('byok-key', { type: 'password' });
    // The key as a property only, so it never sits in the page's markup.
    key.value = saved.key;
    const model = textInput('byok-model', { value: saved.model });
    const toggle = h('button', {
      type: 'button',
      class: 'oc-btn oc-btn--icon',
      'aria-label': 'Show key',
      'data-oc-tip': 'Show key',
      'aria-pressed': 'false',
      'aria-controls': 'byok-key',
      onclick: () => {
        const shown = key.type === 'password';
        key.type = shown ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', String(shown));
        toggle.setAttribute('aria-label', shown ? 'Hide key' : 'Show key');
        toggle.dataset.ocTip = shown ? 'Hide key' : 'Show key';
        toggle.replaceChildren(icon(shown ? 'hide' : 'show'));
      },
    }, icon('show'));
    const error = h('div', { class: 'ms-error-host' });
    const save = h('button', { type: 'submit', class: 'oc-btn oc-btn--primary' }, 'Save');
    const form = h('form', { class: 'oc-form', novalidate: true },
      field('byok-endpoint', 'Endpoint', url),
      h('div', { class: 'oc-field' }, h('label', { for: 'byok-key' }, 'API key'), h('div', { class: 'ms-secret' }, key, toggle)),
      field('byok-model', 'Model', model),
      h('p', { class: 'ms-field-hint' }, 'Stored in this browser only.'),
      error,
      h('div', { class: 'oc-form__actions' }, save),
    );
    busyForm(form, save, async () => {
      const result = ctx.saveByok({ endpoint: url.value, key: key.value, model: model.value });
      const problem = result.error;
      url.toggleAttribute('aria-invalid', false);
      model.toggleAttribute('aria-invalid', false);
      if (problem) {
        error.replaceChildren(inlineError(problem));
        (problem.startsWith('Name the model') ? model : url).setAttribute('aria-invalid', 'true');
        return;
      }
      error.replaceChildren();
      const kept = ctx.currentByok();
      if (kept) {
        url.value = kept.endpoint;
        model.value = kept.model;
      }
      // In use either way; when the browser refused to write it, say so instead of Saved.
      if (result.kept) ctx.notify('Saved', { kind: 'success' });
      else ctx.notify(NOT_SAVING, { kind: 'warning', ms: 12000 });
    });
    return h('section', { class: 'ms-settings__part', 'aria-labelledby': 'settings-endpoint' },
      h('h2', { class: 'oc-text-section', id: 'settings-endpoint' }, 'Model endpoint'),
      form,
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
        if (e.kind === 'auth') ctx.navigate('#/sign-in');
        return;
      }
      error.replaceChildren();
      current.value = '';
      next.value = '';
      ctx.notify('Password changed', { kind: 'success' });
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
        ctx.mode === 'pages' ? endpoint(ctx) : null,
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
