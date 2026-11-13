import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {
  constructor(tag, text) {
    this.tagName = tag;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.text = text ?? '';
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeNode('#text', n) : n;
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ type, target: this, preventDefault() {}, ...extra }); }
  focus() { globalThis.document.activeElement = this; }
  get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((c) => c.textContent).join(''); }
}
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode('#text', text),
};

const { whyLegend, whyTable, whyTableLabel, whyText } = await import('./why-text.js');
const { emptyWhy } = await import('../why.js');

const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.childNodes) all(c, pred, out); return out; };
const cls = (n) => n.getAttribute('class') ?? '';
const words = (el) => el.childNodes.filter((n) => n.tagName !== '#text');
const buttons = (el) => all(el, (n) => n.tagName === 'button');

// Two spaces and a newline on purpose: the whitespace must survive as typed.
const STATE = ' We are  four people,\none is vegetarian. ';
const dinner = {
  key: 'dinner',
  type: 'choice',
  text: 'Dinner?',
  options: [{ name: 'pizza' }, { name: 'sushi' }, { name: 'home' }],
};
const urgency = { key: 'urgency', type: 'score', text: 'How urgent?', levels: [{ text: 'Low' }, { text: 'Mid' }, { text: 'High' }, { text: 'Now' }] };
const wet = { key: 'wet', type: 'noul', text: 'Wet?' };
const run = { state: STATE, questions: [dinner, urgency, wet] };
const base = {
  dinner: { type: 'choice', choice: 'sushi', probabilities: [0.2, 0.47, 0.33], confidence: 0.2 },
  urgency: { type: 'score', score: 2.2, probabilities: [0.1, 0.1, 0.5, 0.3], confidence: 0.5 },
  wet: { type: 'noul', noul: 0.94 },
};

// Seven words: We are four people, one is vegetarian.
// dinner vals: We -1 pt, are ±0, four −4, people, ±0 but flips to pizza, one −2, is ±0, vegetarian. −26 flip.
const measuredWhy = (done = 7) => {
  const w = emptyWhy(run);
  const vals = [0.46, 0.47, 0.43, 0.47, 0.45, 0.47, 0.21].slice(0, done);
  const flips = { 3: 0, 6: 0 };
  w.done = done;
  w.q.dinner = { vals, flips: Object.fromEntries(Object.entries(flips).filter(([i]) => Number(i) < done)) };
  w.q.urgency = { vals: vals.map(() => 2.2), flips: {} };
  w.q.wet = { vals: vals.map(() => 0.94), flips: {} };
  return w;
};

test('every word is an element and the whitespace between survives', () => {
  const el = whyText({ run, base, why: measuredWhy(), key: 'dinner' });
  assert.equal(cls(el), 'ms-why__text');
  assert.equal(el.textContent, STATE);
  assert.deepEqual(words(el).map((n) => n.textContent), ['We', 'are', 'four', 'people,', 'one', 'is', 'vegetarian.']);
  assert.ok(words(el).every((n) => cls(n).split(' ').includes('ms-why__w')));
});

test('a word with an effect is a button with direction, step and numbers', () => {
  const el = whyText({ run, base, why: measuredWhy(), key: 'dinner' });
  const four = words(el)[2];
  assert.equal(four.tagName, 'button');
  assert.equal(four.getAttribute('type'), 'button');
  assert.equal(cls(four), 'ms-why__w ms-why--towards ms-why--s1');
  const label = 'four, without it: sushi 47 % → 43 % (−4)';
  assert.equal(four.getAttribute('aria-label'), label);
  assert.equal(four.getAttribute('data-oc-tip'), label);
  const veg = words(el)[6];
  assert.equal(cls(veg), 'ms-why__w ms-why--towards ms-why--s5 ms-why__w--flip');
  assert.match(veg.getAttribute('aria-label'), /^vegetarian\., without it: sushi 47 % → 21 % \(−26\), pick becomes pizza$/);
});

test('a word without effect is a plain span', () => {
  const el = whyText({ run, base, why: measuredWhy(), key: 'dinner' });
  const are = words(el)[1];
  assert.equal(are.tagName, 'span');
  assert.equal(cls(are), 'ms-why__w');
  assert.equal(are.getAttribute('aria-label'), null);
});

test('a flip word carries the flip class even without effect', () => {
  const el = whyText({ run, base, why: measuredWhy(), key: 'dinner' });
  const people = words(el)[3];
  assert.equal(people.tagName, 'button');
  assert.equal(cls(people), 'ms-why__w ms-why__w--flip');
  assert.match(people.getAttribute('aria-label'), /pick becomes pizza$/);
});

test('unmeasured words are plain and the word being asked is marked out', () => {
  const el = whyText({ run, base, why: measuredWhy(3), key: 'dinner', at: 3 });
  const ws = words(el);
  assert.equal(ws[2].tagName, 'button');
  assert.equal(cls(ws[3]), 'ms-why__w ms-why__w--out');
  assert.ok(ws.slice(4).every((n) => n.tagName === 'span' && cls(n) === 'ms-why__w'));
  assert.equal(el.textContent, STATE);
  const none = whyText({ run, base, why: null, key: 'dinner', at: 0 });
  assert.equal(cls(words(none)[0]), 'ms-why__w ms-why__w--out');
  assert.equal(buttons(none).length, 0);
});

test('exactly one word button is in the tab order', () => {
  const picked = [];
  const el = whyText({ run, base, why: measuredWhy(), key: 'dinner', onWord: (t) => picked.push(t) });
  const bs = buttons(el);
  const tabs = () => bs.map((b) => b.getAttribute('tabindex'));
  assert.equal(bs.length, 5);
  assert.deepEqual(tabs(), ['0', '-1', '-1', '-1', '-1']);
  bs[0].dispatch('keydown', { key: 'ArrowRight' });
  assert.deepEqual(tabs(), ['-1', '0', '-1', '-1', '-1']);
  assert.equal(document.activeElement, bs[1]);
  bs[1].dispatch('keydown', { key: 'End' });
  assert.equal(document.activeElement, bs[4]);
  bs[4].dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(document.activeElement, bs[4]);
  bs[4].dispatch('keydown', { key: 'Home' });
  assert.deepEqual(tabs(), ['0', '-1', '-1', '-1', '-1']);
  bs[0].dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(document.activeElement, bs[0]);
  bs[3].dispatch('click');
  assert.deepEqual(tabs(), ['-1', '-1', '-1', '0', '-1']);
  assert.deepEqual(picked, ['without it: sushi 47 % → 45 % (−2)']);
});

test('the table lists the strongest words with before, after and change', () => {
  const table = whyTable({ run, base, why: measuredWhy(), key: 'dinner' });
  assert.equal(table.tagName, 'table');
  const rows = all(table, (n) => n.tagName === 'tr').slice(1).map((tr) => tr.childNodes.map((td) => td.textContent));
  assert.deepEqual(rows, [
    ['vegetarian ⇄ pizza', '47 % → 21 %', '−26'],
    ['four', '47 % → 43 %', '−4'],
    ['one', '47 % → 45 %', '−2'],
    ['We', '47 % → 46 %', '−1'],
    ['people ⇄ pizza', '47 % → 47 %', '±0'],
  ]);
  assert.equal(whyTableLabel(dinner, base.dinner), 'Strongest words · sushi was 47 %');
  assert.equal(whyTableLabel(urgency, base.urgency), 'Strongest words · score was 2.2');
  assert.equal(whyTableLabel(wet, base.wet), 'Strongest words · yes was 94 %');
});

test('the table is absent when no word has an effect', () => {
  assert.equal(whyTable({ run, base, why: measuredWhy(), key: 'urgency' }), null);
  assert.equal(whyTable({ run, base, why: emptyWhy(run), key: 'dinner' }), null);
});

test('the legend names both directions and the flip mark', () => {
  assert.equal(cls(whyLegend(dinner, base.dinner)), 'ms-why__legend');
  assert.equal(whyLegend(dinner, base.dinner).textContent, 'pulled towards sushipulled away from sushi⇄without it the pick changes');
  assert.match(whyLegend(urgency, base.urgency).textContent, /^raised the scorelowered the score⇄/);
  assert.match(whyLegend(wet, base.wet).textContent, /^towards yestowards no⇄without it the answer changes$/);
});
