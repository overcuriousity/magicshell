// Pickers and menus. Adapted from oc-kit assets/js/menu.js (v2026.11.1).
// picker(select): the native <select> stays on coarse pointers; on fine pointers it becomes a
// keyboard-navigable listbox driving the hidden select. menuButton(): a button opening actions.
// Both close when focus leaves them, so nothing listens on the document after a view is rebuilt.
import { h } from './dom.js';
import { icon } from './icons.js';

export function typeahead(labels, buffer, fromIndex) {
  const b = buffer.toLowerCase();
  for (let step = 1; step <= labels.length; step++) {
    const i = (fromIndex + step + labels.length) % labels.length;
    if (labels[i].toLowerCase().startsWith(b)) return i;
  }
  return -1;
}

export function nextItem(key, active, count) {
  const last = count - 1;
  const keys = { ArrowDown: Math.min(active + 1, last), ArrowUp: Math.max(active - 1, 0), Home: 0, End: last };
  return key in keys ? keys[key] : null;
}

let uid = 0;
const finePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

// Closes `wrap`'s popup when focus moves outside it.
function closeOnLeave(wrap, close) {
  wrap.addEventListener('focusout', (e) => {
    if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) close(false);
  });
}

export function picker(select) {
  select.classList.add('oc-input');
  if (!finePointer()) return select;
  const id = `ms-menu-${++uid}`;
  const options = [...select.options];
  const button = h('button', {
    type: 'button',
    class: 'oc-btn oc-menu-button',
    id: `${id}-button`,
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-controls': id,
    'aria-label': select.getAttribute('aria-label'),
  });
  const list = h('ul', { class: 'oc-menu', id, role: 'listbox', tabindex: '-1', hidden: true });
  // An option's data-hint becomes a second, smaller line in the list.
  const items = options.map((o, i) => {
    const hint = o.getAttribute('data-hint');
    return hint
      ? h('li', { role: 'option', id: `${id}-${i}`, class: 'oc-menu__two', onclick: () => choose(i) }, h('span', {}, o.textContent), h('small', {}, hint))
      : h('li', { role: 'option', id: `${id}-${i}`, onclick: () => choose(i) }, o.textContent);
  });
  list.append(...items);
  let active = select.selectedIndex;
  let buffer = '';
  let bufferTimer;

  const render = () => {
    button.replaceChildren(h('span', {}, options[select.selectedIndex]?.textContent ?? ''), icon('chevron-down'));
    items.forEach((li, i) => {
      li.setAttribute('aria-selected', String(i === select.selectedIndex));
      li.classList.toggle('is-active', i === active);
    });
    list.setAttribute('aria-activedescendant', items[active]?.id ?? '');
  };
  const open = () => {
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    active = Math.max(select.selectedIndex, 0);
    render();
    list.focus();
  };
  const close = (refocus = true) => {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };
  const choose = (i) => {
    const changed = i !== select.selectedIndex;
    if (changed) select.selectedIndex = i;
    close();
    render();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  button.addEventListener('click', () => (list.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    const next = nextItem(e.key, active, items.length);
    if (next !== null) {
      e.preventDefault();
      active = next;
      render();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key.length === 1) {
      clearTimeout(bufferTimer);
      buffer += e.key;
      bufferTimer = setTimeout(() => (buffer = ''), 600);
      const i = typeahead(options.map((o) => o.textContent), buffer, buffer.length > 1 ? active - 1 : active);
      if (i >= 0) {
        active = i;
        render();
      }
    }
  });

  select.classList.add('oc-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const wrap = h('div', { class: 'oc-menu-wrap' }, select, button, list);
  closeOnLeave(wrap, close);
  render();
  return wrap;
}

// items: [{ label, run, disabled }]. `busy` keeps the button focusable but inert (aria-disabled).
export function menuButton(label, items, { disabled = false, busy = false } = {}) {
  const id = `ms-menu-${++uid}`;
  const button = h(
    'button',
    { type: 'button', class: 'oc-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id, disabled, 'aria-disabled': busy ? 'true' : null },
    label,
    icon('chevron-down'),
  );
  const entries = items.map((item) =>
    h('button', {
      type: 'button',
      role: 'menuitem',
      tabindex: '-1',
      disabled: item.disabled,
      onclick: () => {
        close();
        item.run();
      },
    }, item.label),
  );
  const list = h('div', { class: 'oc-menu', id, role: 'menu', hidden: true }, entries);
  let active = 0;
  const focusItem = (i) => {
    active = i;
    entries[i]?.focus();
  };
  const open = () => {
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    focusItem(0);
  };
  const close = (refocus = true) => {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };
  button.addEventListener('click', () => {
    if (busy) return;
    if (list.hidden) open();
    else close();
  });
  button.addEventListener('keydown', (e) => {
    if (busy) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    const next = nextItem(e.key, active, entries.length);
    if (next !== null) {
      e.preventDefault();
      focusItem(next);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  const wrap = h('div', { class: 'oc-menu-wrap' }, button, list);
  closeOnLeave(wrap, close);
  return wrap;
}
