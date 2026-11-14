// Completion for one text field: the rest of a past value in grey behind the caret (Tab takes a
// word), a button that does the same on touch screens, and an optional row of past values to pick.
// The field stays the view's own: a taken word is set as its value and reported as an `input` event.
import { nextWord } from '../suggest.js';
import { h } from './dom.js';

const HINT_ID = 'ms-complete-hint';
const ROW_MAX = 5;
const ANNOUNCE_MS = 700;

// One description for every completing field; looked up each time so a re-rendered page still has it.
function hint() {
  if (!document.getElementById(HINT_ID)) {
    document.body.append(h('span', { class: 'oc-sr-only', id: HINT_ID }, 'Tab takes the suggested word.'));
  }
  return HINT_ID;
}

export function completing(field, { suggest, pool, limit = Infinity, pairedName = () => '', row = null }) {
  if (!suggest || field.hasAttribute('readonly')) return field;

  let rest = '';
  let composing = false;
  // Escape hides the suggestion until the text changes.
  let dismissed = false;
  let timer = null;

  const typed = h('span', { class: 'ms-complete__typed' });
  const restEl = h('span', { class: 'ms-complete__rest' });
  const ghost = h('div', { class: 'ms-complete__ghost', 'aria-hidden': 'true' }, typed, restEl);
  const live = h('span', { class: 'oc-sr-only', 'aria-live': 'polite' });

  const fill = (text) => {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const take = () => {
    if (rest) fill(field.value + nextWord(rest));
  };

  const takeBtn = h('button', {
    type: 'button',
    class: 'oc-btn ms-complete__take',
    // Keep focus in the field, so a phone keeps its keyboard open.
    onpointerdown: (e) => e.preventDefault(),
    onmousedown: (e) => e.preventDefault(),
    onclick: take,
  });
  const strip = h('div', { class: 'ms-complete__strip' }, takeBtn);

  const caretAtEnd = () => field.selectionStart === field.selectionEnd && field.selectionEnd === field.value.length;
  const sync = () => {
    ghost.scrollTop = field.scrollTop;
    ghost.scrollLeft = field.scrollLeft;
  };

  const announce = (next) => {
    clearTimeout(timer);
    if (!next) {
      live.textContent = '';
      return;
    }
    const text = `Suggestion: ${field.value}${next}`;
    timer = setTimeout(() => { live.textContent = text; }, ANNOUNCE_MS);
  };

  const update = () => {
    const show = document.activeElement === field && !composing && !dismissed && caretAtEnd();
    const next = show ? suggest.current().rest(pool, field.value, { limit, pairedName: pairedName() }) : '';
    typed.textContent = field.value;
    restEl.textContent = next;
    if (next !== rest) announce(next);
    rest = next;
    strip.hidden = !rest;
    if (rest) {
      const word = nextWord(rest).trim();
      takeBtn.textContent = `${word} →`;
      takeBtn.setAttribute('aria-label', `Take suggested word: ${word}`);
    }
    sync();
  };

  const label = row ? h('span', { class: 'ms-complete__label' }, row.label) : null;
  const rowEl = row ? h('div', { class: 'ms-complete__row' }) : null;
  const renderRow = () => {
    if (!row) return;
    const items = field.value === '' ? row.items(suggest.current()).slice(0, ROW_MAX) : [];
    rowEl.hidden = items.length === 0;
    rowEl.replaceChildren(label, ...items.map((text) =>
      h('button', {
        type: 'button',
        class: 'oc-btn ms-complete__pick',
        title: text,
        onclick: () => {
          if (row.onPick) {
            row.onPick(text);
            renderRow();
          } else {
            fill(text);
            field.focus();
          }
        },
      }, text)));
  };
  field.addEventListener('input', () => {
    dismissed = false;
    update();
    renderRow();
  });
  for (const type of ['focus', 'keyup', 'click', 'select']) field.addEventListener(type, update);
  field.addEventListener('compositionstart', () => {
    composing = true;
    update();
  });
  field.addEventListener('compositionend', () => {
    composing = false;
    update();
  });
  field.addEventListener('blur', update);
  field.addEventListener('scroll', sync);
  field.addEventListener('keydown', (e) => {
    if (!rest) return;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      take();
    } else if (e.key === 'Escape') {
      // So a dialog or panel around the field does not close on the same key.
      e.stopPropagation();
      dismissed = true;
      update();
    }
  });

  const described = field.getAttribute('aria-describedby');
  const id = hint();
  if (!(described ?? '').split(/\s+/).includes(id)) field.setAttribute('aria-describedby', described ? `${described} ${id}` : id);

  const wrap = h('div', { class: 'ms-complete' }, h('div', { class: 'ms-complete__box' }, field, ghost), strip, rowEl, live);
  update();
  renderRow();
  suggest.load().then(() => {
    update();
    renderRow();
  });
  return wrap;
}
