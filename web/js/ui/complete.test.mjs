import assert from 'node:assert/strict';
import test from 'node:test';
import { createSuggestions } from '../suggest.js';

// A small DOM: enough for h(), a field with a caret and focus, and the wrapper around it.
class FakeNode {
  constructor(tag, text) {
    this.tagName = tag;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.text = text ?? '';
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.scrollHeight = 0;
    this._value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  // Like a browser: setting the value puts the caret at the end.
  get value() { return this._value; }
  set value(v) {
    this._value = String(v);
    this.selectionStart = this.selectionEnd = this._value.length;
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  get classList() {
    const names = () => (this.getAttribute('class') ?? '').split(' ').filter(Boolean);
    return {
      contains: (c) => names().includes(c),
      toggle: (c, on = !names().includes(c)) => {
        const rest = names().filter((n) => n !== c);
        this.setAttribute('class', (on ? [...rest, c] : rest).join(' '));
        return on;
      },
    };
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = n !== null && typeof n === 'object' ? n : new FakeNode('#text', String(n));
      if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatchEvent(event) {
    Object.defineProperty(event, 'target', { value: this, configurable: true });
    for (const fn of this.listeners[event.type] ?? []) fn(event);
    return !event.defaultPrevented;
  }
  focus() {
    if (document.activeElement === this) return;
    const was = document.activeElement;
    document.activeElement = this;
    was?.dispatchEvent(new Event('blur'));
    this.dispatchEvent(new Event('focus'));
  }
  blur() {
    if (document.activeElement !== this) return;
    document.activeElement = document.body;
    this.dispatchEvent(new Event('blur'));
  }
  get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(...(v === '' ? [] : [new FakeNode('#text', String(v))])); }
}
const body = new FakeNode('body');
const find = (n, pred) => (pred(n) ? n : n.childNodes.reduce((hit, c) => hit ?? find(c, pred), null));
globalThis.document = {
  body,
  activeElement: body,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode('#text', text),
  getElementById: (id) => find(body, (n) => n.getAttribute('id') === id),
};

const { h } = await import('./dom.js');
const { completing } = await import('./complete.js');

const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.childNodes) all(c, pred, out); return out; };
const byClass = (root, c) => all(root, (n) => (n.getAttribute('class') ?? '').split(' ').includes(c));
const one = (root, c) => byClass(root, c)[0];

const entry = (at, state, questions) => ({ id: at, at, run: { state, questions } });
const choice = (text, ...names) => ({ key: 'team', type: 'choice', text, options: names.map((n) => ({ id: n, name: n, description: `${n} things` })) });
const history = [
  entry('2026-11-10T10:00:00Z', 'Printer is on fire', [choice('Which team should handle this?', 'billing', 'tech')]),
  entry('2026-11-12T10:00:00Z', 'Printer is out of paper', [choice('Which tool fits?', 'tech', 'sales')]),
];
const stub = (h_ = history) => ({ load: async () => {}, current: () => createSuggestions({ history: h_ }) });

// A field as a view builds it, with its own input listener, wrapped and in the page.
function setup(opts = {}, { tag = 'input', ...attrs } = {}) {
  const seen = [];
  const field = h(tag, { type: tag === 'input' ? 'text' : null, class: 'oc-input', id: 'f', 'data-fid': 'f', oninput: (e) => seen.push(e.target.value), ...attrs });
  const wrap = completing(field, { suggest: stub(), pool: 'question', ...opts });
  body.append(wrap);
  return { field, wrap, seen, rest: () => one(wrap, 'ms-complete__rest').textContent, strip: () => one(wrap, 'ms-complete__strip') };
}
// Typing as a browser reports it: the value changes with the caret at the end, then `input`.
function type(field, value) {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
function key(field, k, mods = {}) {
  const e = new Event('keydown', { cancelable: true });
  Object.assign(e, { key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });
  let stopped = false;
  e.stopPropagation = () => { stopped = true; };
  field.dispatchEvent(e);
  return { prevented: e.defaultPrevented, stopped };
}
const fire = (node, type_) => node.dispatchEvent(new Event(type_, { cancelable: true }));

test('typing shows the rest, Tab takes one word and reports it as typing', () => {
  const { field, wrap, seen, rest } = setup();
  field.focus();
  type(field, 'Which te');
  assert.equal(rest(), 'am should handle this?');
  assert.equal(one(wrap, 'ms-complete__typed').textContent, 'Which te');
  seen.length = 0;
  assert.equal(key(field, 'Tab').prevented, true);
  assert.equal(field.value, 'Which team');
  assert.deepEqual(seen, ['Which team']);
  key(field, 'Tab');
  assert.equal(field.value, 'Which team should');
});

test('the wrapper holds the box, the strip and the row in order, and the field keeps its id', () => {
  const { field, wrap } = setup({ row: { label: 'Recent:', items: () => [] } });
  assert.equal(wrap.getAttribute('class'), 'ms-complete');
  assert.deepEqual(wrap.childNodes.filter((c) => c.tagName === 'div').map((c) => c.getAttribute('class')), ['ms-complete__box', 'ms-complete__strip', 'ms-complete__row']);
  const box = wrap.childNodes[0];
  assert.equal(box.childNodes[0], field);
  assert.equal(box.childNodes[1].getAttribute('class'), 'ms-complete__ghost');
  assert.equal(box.childNodes[1].getAttribute('aria-hidden'), 'true');
  assert.equal(field.getAttribute('id'), 'f');
  assert.equal(field.getAttribute('data-fid'), 'f');
});

test('Tab with no suggestion is left alone', () => {
  const { field } = setup();
  field.focus();
  type(field, 'zzz');
  assert.equal(key(field, 'Tab').prevented, false);
  assert.equal(field.value, 'zzz');
});

test('Shift+Tab and Ctrl+Tab are never taken', () => {
  const { field, rest } = setup();
  field.focus();
  type(field, 'Which te');
  for (const mods of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    assert.equal(key(field, 'Tab', mods).prevented, false);
    assert.equal(field.value, 'Which te');
  }
  assert.equal(rest(), 'am should handle this?');
});

test('the caret away from the end hides the suggestion', () => {
  const { field, rest, strip } = setup();
  field.focus();
  type(field, 'Which te');
  assert.equal(strip().hidden, false);
  field.selectionStart = field.selectionEnd = 2;
  fire(field, 'click');
  assert.equal(rest(), '');
  assert.equal(strip().hidden, true);
  assert.equal(key(field, 'Tab').prevented, false);
  // A selection that ends at the end is not a caret at the end either.
  field.selectionStart = 2;
  field.selectionEnd = field.value.length;
  fire(field, 'select');
  assert.equal(rest(), '');
});

test('Escape hides it until the text changes', () => {
  const { field, rest } = setup();
  field.focus();
  type(field, 'Which te');
  assert.equal(key(field, 'Escape').stopped, true);
  assert.equal(rest(), '');
  fire(field, 'keyup');
  assert.equal(rest(), '');
  type(field, 'Which t');
  assert.equal(rest(), 'ool fits?');
  // With nothing showing, Escape goes on to whoever else listens.
  type(field, 'zzz');
  assert.equal(key(field, 'Escape').stopped, false);
});

test('nothing while composing', () => {
  const { field, rest } = setup();
  field.focus();
  fire(field, 'compositionstart');
  type(field, 'Which te');
  assert.equal(rest(), '');
  assert.equal(key(field, 'Tab').prevented, false);
  fire(field, 'compositionend');
  assert.equal(rest(), 'am should handle this?');
});

test('blur clears it', () => {
  const { field, rest, strip } = setup();
  field.focus();
  type(field, 'Which te');
  field.blur();
  assert.equal(rest(), '');
  assert.equal(strip().hidden, true);
  // Text typed by script while the field is not focused shows nothing.
  type(field, 'Which t');
  assert.equal(rest(), '');
});

test('a window blur clears it too, though the field stays the active element', () => {
  const { field, rest, strip } = setup();
  field.focus();
  type(field, 'Which te');
  // Switching windows: the field gets `blur` but document.activeElement does not change.
  fire(field, 'blur');
  assert.equal(document.activeElement, field);
  assert.equal(rest(), '');
  assert.equal(strip().hidden, true);
  assert.equal(key(field, 'Tab').prevented, false);
  // Coming back gives the field `focus`, and the suggestion returns.
  fire(field, 'focus');
  assert.equal(rest(), 'am should handle this?');
});

test('the limit holds', () => {
  const { field, rest } = setup({ limit: 10 });
  field.focus();
  type(field, 'Which te');
  assert.equal(rest(), 'am');
  key(field, 'Tab');
  assert.equal(field.value, 'Which team');
  assert.equal(rest(), '');
});

test('the strip button takes a word and keeps focus', () => {
  const { field, wrap, seen } = setup();
  field.focus();
  type(field, 'Which te');
  const take = one(wrap, 'ms-complete__take');
  assert.equal(take.tagName, 'button');
  assert.equal(take.getAttribute('type'), 'button');
  assert.ok(byClass(wrap, 'oc-btn').includes(take));
  assert.equal(take.textContent, 'am →');
  assert.equal(take.getAttribute('aria-label'), 'Take suggested word: am');
  const down = new Event('pointerdown', { cancelable: true });
  take.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  const mouse = new Event('mousedown', { cancelable: true });
  take.dispatchEvent(mouse);
  assert.equal(mouse.defaultPrevented, true);
  seen.length = 0;
  fire(take, 'click');
  assert.equal(field.value, 'Which team');
  assert.deepEqual(seen, ['Which team']);
  assert.equal(document.activeElement, field);
  assert.equal(take.textContent, 'should →');
});

test('the row shows only while the field is empty', () => {
  const { field, wrap, seen } = setup({ row: { label: 'Recent:', items: (s) => s.recent('question') } });
  const row = one(wrap, 'ms-complete__row');
  assert.equal(row.hidden, false);
  assert.equal(one(row, 'ms-complete__label').textContent, 'Recent:');
  const picks = byClass(row, 'ms-complete__pick');
  assert.deepEqual(picks.map((p) => p.textContent), ['Which tool fits?', 'Which team should handle this?']);
  assert.equal(picks[0].getAttribute('title'), 'Which tool fits?');
  assert.equal(picks[0].getAttribute('type'), 'button');
  fire(picks[1], 'click');
  assert.equal(field.value, 'Which team should handle this?');
  assert.deepEqual(seen, ['Which team should handle this?']);
  assert.equal(document.activeElement, field);
  assert.equal(row.hidden, true);
  type(field, '');
  assert.equal(row.hidden, false);
});

test('the row offers at most five', () => {
  const many = Array.from({ length: 7 }, (_, i) => entry(`2026-11-0${i + 1}T00:00:00Z`, '', [choice(`q${i}`)]));
  const field = h('input', { type: 'text', class: 'oc-input' });
  const wrap = completing(field, { suggest: stub(many), pool: 'question', row: { label: 'Recent:', items: (s) => s.recent('question', 10) } });
  assert.equal(byClass(wrap, 'ms-complete__pick').length, 5);
});

test('a row with nothing to offer is not shown', () => {
  const { wrap } = setup({ row: { label: 'Often used:', items: () => [] } });
  assert.equal(one(wrap, 'ms-complete__row').hidden, true);
});

test('onPick replaces filling the field', () => {
  const picked = [];
  const { field, wrap, seen } = setup({ row: { label: 'Recent:', items: (s) => s.recent('option'), onPick: (t) => picked.push(t) } });
  fire(byClass(wrap, 'ms-complete__pick')[0], 'click');
  assert.deepEqual(picked, ['tech']);
  assert.equal(field.value, '');
  assert.deepEqual(seen, []);
});

test('the row and the rest are drawn again once the source has loaded', async () => {
  let data = [];
  let done;
  const loaded = new Promise((r) => { done = r; });
  const suggest = { load: () => loaded, current: () => createSuggestions({ history: data }) };
  const field = h('input', { type: 'text', class: 'oc-input' });
  const wrap = completing(field, { suggest, pool: 'question', row: { label: 'Recent:', items: (s) => s.recent('question') } });
  body.append(wrap);
  assert.equal(one(wrap, 'ms-complete__row').hidden, true);
  data = history;
  done();
  await loaded;
  await null;
  assert.equal(one(wrap, 'ms-complete__row').hidden, false);

  // Text typed before the source arrived gets its rest when it does.
  data = [];
  let done2;
  const loaded2 = new Promise((r) => { done2 = r; });
  const field2 = h('input', { type: 'text', class: 'oc-input' });
  const wrap2 = completing(field2, { suggest: { load: () => loaded2, current: () => createSuggestions({ history: data }) }, pool: 'question' });
  body.append(wrap2);
  field2.focus();
  type(field2, 'Which te');
  assert.equal(one(wrap2, 'ms-complete__rest').textContent, '');
  data = history;
  done2();
  await loaded2;
  await null;
  assert.equal(one(wrap2, 'ms-complete__rest').textContent, 'am should handle this?');
});

test('a read-only field or a missing source is returned untouched', () => {
  const field = h('input', { type: 'text', class: 'oc-input' });
  assert.equal(completing(field, { suggest: null, pool: 'question' }), field);
  assert.equal(completing(field, { suggest: undefined, pool: 'question' }), field);
  const locked = h('input', { type: 'text', class: 'oc-input', readonly: true });
  assert.equal(completing(locked, { suggest: stub(), pool: 'question' }), locked);
  assert.equal(locked.getAttribute('aria-describedby'), null);
});

test('the paired name is read at the time of typing', () => {
  const h2 = [
    entry('2026-11-01T00:00:00Z', '', [{ key: 'k', text: 'q', options: [{ name: 'tech', description: 'errors and outages' }] }]),
    entry('2026-11-02T00:00:00Z', '', [{ key: 'k', text: 'q', options: [{ name: 'other', description: 'everything else' }] }]),
  ];
  let name = '';
  const field = h('textarea', { class: 'oc-input' });
  const wrap = completing(field, { suggest: stub(h2), pool: 'description', pairedName: () => name });
  body.append(wrap);
  field.focus();
  type(field, 'e');
  assert.equal(one(wrap, 'ms-complete__rest').textContent, 'verything else');
  name = 'Tech';
  type(field, 'e');
  assert.equal(one(wrap, 'ms-complete__rest').textContent, 'rrors and outages');
});

test('the ghost follows the field\'s scrolling', () => {
  const { field, wrap } = setup({}, { tag: 'textarea' });
  field.focus();
  type(field, 'Which te');
  field.scrollTop = 40;
  field.scrollLeft = 7;
  fire(field, 'scroll');
  const ghost = one(wrap, 'ms-complete__ghost');
  assert.equal(ghost.scrollTop, 40);
  assert.equal(ghost.scrollLeft, 7);
});

test('the typed text in the ghost is the value exactly, trailing spaces and newlines included', () => {
  const { field, wrap } = setup({}, { tag: 'textarea' });
  field.focus();
  type(field, 'Which \n ');
  assert.equal(one(wrap, 'ms-complete__typed').textContent, 'Which \n ');
});

test('the field is described by one shared hint, added to what it had', () => {
  const a = setup({}, { 'aria-describedby': 'own-hint' }).field;
  const b = setup().field;
  assert.equal(a.getAttribute('aria-describedby'), 'own-hint ms-complete-hint');
  assert.equal(b.getAttribute('aria-describedby'), 'ms-complete-hint');
  const hints = all(body, (n) => n.getAttribute('id') === 'ms-complete-hint');
  assert.equal(hints.length, 1);
  assert.equal(hints[0].parentNode, body);
  assert.equal(hints[0].getAttribute('class'), 'oc-sr-only');
  assert.equal(hints[0].textContent, 'Tab takes the suggested word. Escape hides it.');
});

test('the suggestion is announced once it has stayed for 700 ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { field, wrap } = setup();
  const live = all(wrap, (n) => n.getAttribute('aria-live') === 'polite')[0];
  assert.equal(live.getAttribute('class'), 'oc-sr-only');
  field.focus();
  type(field, 'Which t');
  t.mock.timers.tick(500);
  type(field, 'Which te');
  t.mock.timers.tick(699);
  assert.equal(live.textContent, '');
  t.mock.timers.tick(1);
  assert.equal(live.textContent, 'Suggestion: am should handle this?');
  type(field, 'zzz');
  assert.equal(live.textContent, '');
  t.mock.timers.tick(1000);
  assert.equal(live.textContent, '');
});

test('the announcement is the rest only, cut at 80 characters', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const long = `Which ${'x'.repeat(100)}`;
  const field = h('input', { type: 'text', class: 'oc-input' });
  const wrap = completing(field, { suggest: stub([entry('2026-11-13T00:00:00Z', '', [choice(long)])]), pool: 'question' });
  body.append(wrap);
  const live = all(wrap, (n) => n.getAttribute('aria-live') === 'polite')[0];
  field.focus();
  type(field, 'Which');
  t.mock.timers.tick(700);
  assert.equal(live.textContent, `Suggestion: ${` ${'x'.repeat(100)}`.slice(0, 80)}…`);
});

// A browser's insertText: at the caret (here the end), with its own `input` event.
function withExecCommand(t, result = true) {
  const calls = [];
  document.execCommand = (cmd, ui, text) => {
    calls.push([cmd, ui, text]);
    if (!result) return false;
    const f = document.activeElement;
    f.value += text;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  t.after(() => { delete document.execCommand; });
  return calls;
}

test('a taken word goes in through insertText, so undo takes it back, with one input event', (t) => {
  const calls = withExecCommand(t);
  const { field, seen } = setup();
  field.focus();
  type(field, 'Which te');
  seen.length = 0;
  assert.equal(key(field, 'Tab').prevented, true);
  assert.deepEqual(calls, [['insertText', false, 'am']]);
  assert.equal(field.value, 'Which team');
  assert.deepEqual(seen, ['Which team']);
});

// Chromium's insertText leaves a full field where it was, with the new word out of sight.
test('a word taken through insertText is scrolled into view, the grey text with it', (t) => {
  withExecCommand(t);
  const { field, wrap } = setup();
  field.focus();
  type(field, 'Which te');
  field.scrollWidth = 300;
  field.scrollHeight = 90;
  key(field, 'Tab');
  assert.equal(field.scrollLeft, 300);
  assert.equal(field.scrollTop, 90);
  const ghost = byClass(wrap, 'ms-complete__ghost')[0];
  assert.equal(ghost.scrollLeft, 300);
  assert.equal(ghost.scrollTop, 90);
});

test('a row pick focuses the field and goes in through insertText too', (t) => {
  const calls = withExecCommand(t);
  const { field, wrap, seen } = setup({ row: { label: 'Recent:', items: (s) => s.recent('question') } });
  fire(byClass(wrap, 'ms-complete__pick')[0], 'click');
  assert.deepEqual(calls, [['insertText', false, 'Which tool fits?']]);
  assert.equal(document.activeElement, field);
  assert.deepEqual(seen, ['Which tool fits?']);
});

test('without insertText the value is set, reported once, and scrolled to its end', (t) => {
  const calls = withExecCommand(t, false);
  const { field, seen } = setup();
  field.focus();
  type(field, 'Which te');
  field.scrollWidth = 300;
  field.scrollHeight = 90;
  seen.length = 0;
  key(field, 'Tab');
  assert.equal(calls.length, 1);
  assert.equal(field.value, 'Which team');
  assert.deepEqual(seen, ['Which team']);
  assert.equal(field.scrollLeft, 300);
  assert.equal(field.scrollTop, 90);
});

test('a row pick longer than the limit is cut to it', () => {
  const { field } = setup({ limit: 5, row: { label: 'Recent:', items: (s) => s.recent('question') } });
  const wrap = field.parentNode.parentNode;
  fire(byClass(wrap, 'ms-complete__pick')[0], 'click');
  assert.equal(field.value, 'Which');
});

test('a caret moved by a key without keyup is seen before Tab', () => {
  const { field } = setup();
  field.focus();
  type(field, 'Which te');
  // ArrowLeft moves the caret on keydown; the Tab's keydown comes before any keyup.
  field.selectionStart = field.selectionEnd = 7;
  key(field, 'ArrowLeft');
  assert.equal(key(field, 'Tab').prevented, false);
  assert.equal(field.value, 'Which te');
});

test('the strip button checks the caret before taking', () => {
  const { field, wrap } = setup();
  field.focus();
  type(field, 'Which te');
  const take = one(wrap, 'ms-complete__take');
  field.selectionStart = field.selectionEnd = 2;
  fire(take, 'click');
  assert.equal(field.value, 'Which te');
});

test('a field whose text overflows marks the wrapper clipped while a rest shows', () => {
  const { field, wrap } = setup();
  field.focus();
  field.clientWidth = 200;
  field.scrollWidth = 300;
  type(field, 'Which te');
  assert.equal(wrap.classList.contains('ms-complete--clipped'), true);
  type(field, 'zzz');
  assert.equal(wrap.classList.contains('ms-complete--clipped'), false);
  type(field, 'Which te');
  assert.equal(wrap.classList.contains('ms-complete--clipped'), true);
  field.scrollWidth = 200;
  type(field, 'Which t');
  assert.equal(wrap.classList.contains('ms-complete--clipped'), false);
  assert.equal(wrap.getAttribute('class'), 'ms-complete');
});

test('pick buttons carry an id after their field\'s', () => {
  const { wrap } = setup({ row: { label: 'Recent:', items: (s) => s.recent('question') } });
  assert.deepEqual(byClass(wrap, 'ms-complete__pick').map((p) => p.getAttribute('data-fid')), ['f-pick-0', 'f-pick-1']);
});
