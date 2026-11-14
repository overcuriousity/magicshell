// Completion for one text field: the rest of a past value in grey behind the caret (Tab takes a
// word), a button that does the same on touch screens (and wherever the text runs past the field's
// edge), and an optional row of past values to pick.
// The field stays the view's own: a taken word is typed in through the browser, so undo takes it
// back, and the view hears it as an `input` event.
import { cut, nextWord } from '../suggest.js';
import { h } from './dom.js';

const HINT_ID = 'ms-complete-hint';
const ROW_MAX = 5;
const ANNOUNCE_MS = 700;
const ANNOUNCE_MAX = 80;

// One description for every completing field; looked up each time so a re-rendered page still has it.
function hint() {
  if (!document.getElementById(HINT_ID)) {
    document.body.append(h('span', { class: 'oc-sr-only', id: HINT_ID }, 'Tab takes the suggested word. Escape hides it.'));
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
  // Set by blur, cleared by focus: when the window loses focus the field gets `blur`
  // but stays document.activeElement, so that alone cannot tell.
  let away = false;

  const typed = h('span', { class: 'ms-complete__typed' });
  const restEl = h('span', { class: 'ms-complete__rest' });
  const ghost = h('div', { class: 'ms-complete__ghost', 'aria-hidden': 'true' }, typed, restEl);
  const live = h('span', { class: 'oc-sr-only', 'aria-live': 'polite' });

  // At the caret, which is at the end whenever this is called. insertText keeps the browser's undo
  // and fires its own `input`; without it the value is set and the event sent once by hand. Either
  // way the field is scrolled to its end, where the new text is: Chromium's insertText does not.
  const insert = (text) => {
    const word = cut(text, limit - field.value.length);
    if (!word) return;
    if (!(document.activeElement === field && document.execCommand?.('insertText', false, word))) {
      field.value += word;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Only one of the two moves anything: an input scrolls sideways, a textarea down.
    field.scrollLeft = field.scrollWidth;
    field.scrollTop = field.scrollHeight;
    sync();
  };
  // The rest is worked out again first: a key or click may have moved the caret since it was drawn.
  const take = () => {
    update();
    if (rest) insert(nextWord(rest));
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

  const label = row ? h('span', { class: 'ms-complete__label' }, row.label) : null;
  const rowEl = row ? h('div', { class: 'ms-complete__row' }) : null;
  const wrap = h('div', { class: 'ms-complete' }, h('div', { class: 'ms-complete__box' }, field, ghost), strip, rowEl, live);

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
    // The rest only: the typed part has been heard already, and a long one would drown the rest.
    const shown = next.length > ANNOUNCE_MAX ? `${cut(next, ANNOUNCE_MAX)}…` : next;
    const text = `Suggestion: ${shown}`;
    timer = setTimeout(() => { live.textContent = text; }, ANNOUNCE_MS);
  };

  const update = () => {
    const show = !away && document.activeElement === field && !composing && !dismissed && caretAtEnd();
    const next = show ? suggest.current().rest(pool, field.value, { limit, pairedName: pairedName() }) : '';
    typed.textContent = field.value;
    restEl.textContent = next;
    if (next !== rest) announce(next);
    rest = next;
    strip.hidden = !rest;
    // Text past the right edge hides the grey rest, so the strip shows on any pointer then.
    wrap.classList.toggle('ms-complete--clipped', Boolean(rest) && field.scrollWidth > field.clientWidth);
    if (rest) {
      const word = nextWord(rest).trim();
      takeBtn.textContent = `${word} →`;
      takeBtn.setAttribute('aria-label', `Take suggested word: ${word}`);
    }
    sync();
  };

  const renderRow = () => {
    if (!row) return;
    const items = field.value === '' ? row.items(suggest.current()).slice(0, ROW_MAX) : [];
    rowEl.hidden = items.length === 0;
    // An id of their own, so a view rebuilt under a pick can find the field's place again.
    const fid = field.getAttribute('data-fid');
    rowEl.replaceChildren(label, ...items.map((text, i) =>
      h('button', {
        type: 'button',
        class: 'oc-btn ms-complete__pick',
        title: text,
        'data-fid': fid ? `${fid}-pick-${i}` : null,
        onclick: () => {
          if (row.onPick) {
            row.onPick(text);
            renderRow();
          } else {
            // The field is empty: focused, the text goes in where insertText puts it.
            field.focus();
            insert(text);
          }
        },
      }, text)));
  };
  field.addEventListener('input', () => {
    dismissed = false;
    update();
    renderRow();
  });
  for (const type of ['keyup', 'click', 'select']) field.addEventListener(type, update);
  field.addEventListener('focus', () => {
    away = false;
    update();
  });
  field.addEventListener('compositionstart', () => {
    composing = true;
    update();
  });
  field.addEventListener('compositionend', () => {
    composing = false;
    update();
  });
  field.addEventListener('blur', () => {
    away = true;
    update();
  });
  field.addEventListener('scroll', sync);
  field.addEventListener('keydown', (e) => {
    // An arrow key moves the caret on keydown; the next key can come before its keyup.
    update();
    if (!rest) return;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      insert(nextWord(rest));
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

  update();
  renderRow();
  suggest.load().then(() => {
    update();
    renderRow();
  });
  return wrap;
}
