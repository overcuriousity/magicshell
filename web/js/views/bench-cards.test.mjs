import assert from 'node:assert/strict';
import test from 'node:test';

// A small DOM: enough for h(), the question cards and their listeners.
class FakeNode {
  constructor(tag, text) {
    this.tagName = tag;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.text = text ?? '';
    this.value = '';
    const names = () => (this.getAttribute('class') ?? '').split(' ').filter(Boolean);
    this.classList = {
      add: (c) => this.setAttribute('class', [...names(), c].join(' ')),
      toggle: (c, on) => this.setAttribute('class', [...names().filter((n) => n !== c), ...(on ? [c] : [])].join(' ')),
    };
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'value') this.value = String(v);
  }
  hasAttribute(k) { return this.attributes.has(k); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  append(...nodes) {
    for (const n of nodes) {
      // Like a browser: anything that is not a node becomes a text node (null as "null").
      const node = n !== null && typeof n === 'object' ? n : new FakeNode('#text', String(n));
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  get options() { return this.childNodes.filter((c) => c.tagName === 'option'); }
  get selectedIndex() { return Math.max(0, this.options.findIndex((o) => o.attributes.has('selected'))); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ type, target: this, ...extra }); }
  get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.childNodes = []; this.text = ''; this.append(String(t)); }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
}
globalThis.document = {
  activeElement: null,
  body: new FakeNode('body'),
  getElementById: () => null,
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode('#text', text),
};

const { questionCards } = await import('./bench-cards.js');
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.childNodes) all(c, pred, out); return out; };
const byFid = (root, fid) => all(root, (n) => n.getAttribute('data-fid') === fid)[0];

const run = () => ({
  state: '',
  questions: [
    { key: 'dinner', type: 'choice', text: 'Where?', options: [{ id: 'o1', name: 'pizza', description: '' }, { id: 'o2', name: 'sushi', description: '' }, { id: 'o3', name: 'home', description: '' }] },
  ],
});

function recordingOps() {
  const calls = [];
  const ops = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, ...args]); return true; } });
  return { ops, calls };
}

test('the question text has a real label, with ids and focus ids unique per editor', () => {
  const { ops } = recordingOps();
  const [a] = questionCards(run(), ops, { idPrefix: 'bench-a' });
  const [b] = questionCards(run(), ops, { idPrefix: 'bench-b', fidPrefix: 'b', locked: true });
  for (const [card, id, fq] of [[a, 'bench-a-q0-text', 'q0'], [b, 'bench-b-bq0-text', 'bq0']]) {
    const label = all(card, (n) => n.tagName === 'label' && n.textContent === 'Question')[0];
    assert.equal(label?.getAttribute('for'), id);
    const keyLabel = all(card, (n) => n.tagName === 'label' && n.textContent === 'Key')[0];
    assert.equal(keyLabel?.getAttribute('for'), id.replace(/-text$/, '-key'));
    assert.equal(byFid(card, `${fq}:key`).getAttribute('id'), id.replace(/-text$/, '-key'));
    const input = byFid(card, `${fq}:text`);
    assert.equal(input.getAttribute('id'), id);
    assert.equal(input.getAttribute('aria-label'), null);
    assert.equal(all(card, (n) => n.getAttribute('aria-hidden') === 'true' && n.textContent === 'Question').length, 0);
  }
});

test('Ctrl+Enter in the key field commits the new key before the run sees it', () => {
  const { ops, calls } = recordingOps();
  const [card] = questionCards(run(), ops);
  const key = byFid(card, 'q0:key');
  key.value = ' where ';
  key.dispatch('keydown', { key: 'Enter', ctrlKey: true });
  assert.deepEqual(calls, [['renameQuestion', 'dinner', 'where']]);
  // The change event that follows on blur finds nothing left to commit.
  key.dispatch('change');
  assert.equal(calls.length, 1);
  // Later edits use the committed key.
  byFid(card, 'q0:text').dispatch('input', { target: { value: 'Where now?' } });
  assert.deepEqual(calls[1], ['updateText', 'where', 'Where now?']);
});

test('a key is committed once, on change, not again on blur', () => {
  const { ops, calls } = recordingOps();
  const [card] = questionCards(run(), ops);
  const key = byFid(card, 'q0:key');
  key.value = 'where';
  key.dispatch('input');
  assert.equal(calls.length, 0);
  key.dispatch('change');
  assert.deepEqual(calls, [['renameQuestion', 'dinner', 'where']]);
  key.dispatch('blur');
  assert.equal(calls.length, 1);
});

test('plain Enter in the key field does not commit early', () => {
  const { ops, calls } = recordingOps();
  const [card] = questionCards(run(), ops);
  const key = byFid(card, 'q0:key');
  key.value = 'where';
  key.dispatch('keydown', { key: 'Enter' });
  assert.equal(calls.length, 0);
});

test('option dots take the colour slots given (B keeps A\'s colours)', () => {
  const { ops } = recordingOps();
  const [card] = questionCards(run(), ops, { locked: true, slotsFor: () => [2, 0, 3] });
  const dots = all(card, (n) => (n.getAttribute('class') ?? '').startsWith('ms-dot'));
  assert.deepEqual(dots.map((d) => d.getAttribute('class')), ['ms-dot opt-3', 'ms-dot opt-1', 'ms-dot opt-4']);
});

// A suggestion source that offers nothing; `asked` records every pairedName it was given.
function stubSuggest(asked = []) {
  const current = { rest: (_pool, _text, o) => { asked.push(o?.pairedName); return ''; }, recent: () => [], frequent: () => [] };
  return { load: () => Promise.resolve(), current: () => current };
}
const wrappers = (card) => all(card, (n) => n.getAttribute('class') === 'ms-complete');

test('without a suggestion source the cards are as before', () => {
  const { ops } = recordingOps();
  const [card] = questionCards(run(), ops);
  assert.equal(wrappers(card).length, 0);
});

test('with a source every editable text field is wrapped, a locked key is not', () => {
  const { ops } = recordingOps();
  const [card] = questionCards(run(), ops, { suggest: stubSuggest() });
  // key + question + 3 names + 3 descriptions
  assert.equal(wrappers(card).length, 8);
  const [locked] = questionCards(run(), ops, { suggest: stubSuggest(), locked: true });
  assert.equal(wrappers(locked).length, 7);
  assert.notEqual(byFid(locked, 'q0:key').parentNode.getAttribute('class'), 'ms-complete__box');
});

test('a description prefers the one used with the name in its row', () => {
  const asked = [];
  const { ops } = recordingOps();
  const [card] = questionCards(run(), ops, { suggest: stubSuggest(asked) });
  const name = byFid(card, 'q0:option:o1:name');
  const desc = byFid(card, 'q0:option:o1:desc');
  name.value = 'tech';
  name.dispatch('input', { target: name });
  asked.length = 0;
  document.activeElement = desc;
  desc.selectionStart = desc.selectionEnd = desc.value.length;
  desc.dispatch('focus');
  assert.ok(asked.includes('tech'), `asked ${JSON.stringify(asked)}`);
});
