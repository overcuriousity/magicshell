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
    this.classList = { add: (c) => this.setAttribute('class', `${this.getAttribute('class') ?? ''} ${c}`.trim()) };
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'value') this.value = String(v);
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeNode('#text', n) : n;
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  get options() { return this.childNodes.filter((c) => c.tagName === 'option'); }
  get selectedIndex() { return Math.max(0, this.options.findIndex((o) => o.attributes.has('selected'))); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ type, target: this, ...extra }); }
  get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((c) => c.textContent).join(''); }
}
globalThis.document = {
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
