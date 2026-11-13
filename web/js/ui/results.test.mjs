import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

class FakeNode {
  constructor(tag, text) {
    this.tagName = tag;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.text = text ?? '';
    this.vars = new Map();
    this.style = { setProperty: (k, v) => this.vars.set(k, v) };
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  append(...nodes) {
    for (const n of nodes) {
      // Like a browser: anything that is not a node becomes a text node (null as "null").
      const node = n !== null && typeof n === 'object' ? n : new FakeNode('#text', String(n));
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatch(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ type, target: this, ...extra }); }
  get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((c) => c.textContent).join(''); }
  find(pred) {
    if (pred(this)) return this;
    for (const c of this.childNodes) { const f = c.find(pred); if (f) return f; }
    return null;
  }
}
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode('#text', text),
};


const { choiceResult, guidedVerdict, noulResult, scoreResult } = await import('./results.js');
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/systemone/response-${name}.json`, import.meta.url), 'utf8'));
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.childNodes) all(c, pred, out); return out; };
const cls = (n) => n.getAttribute('class') ?? '';
const bars = (root) => all(root, (n) => n.getAttribute('role') === 'img');

const choice = { type: 'choice', options: [{ name: 'pizza' }, { name: 'sushi' }, { name: 'home' }] };
const choiceAnswer = { type: 'choice', choice: 'sushi', probabilities: [0.2236, 0.4725, 0.3039], confidence: 0.2088 };
const score = { type: 'score', levels: [{ text: 'Not urgent' }, { text: 'Can wait' }, { text: 'Today' }, { text: 'Now' }] };
const scoreAnswer = { type: 'score', score: 2.2296, probabilities: [0.04, 0.02, 0.62, 0.32], confidence: 0.58 };

test('choice: pick, confidence and one bar per option in option order', () => {
  const el = choiceResult(choice, choiceAnswer, {});
  assert.match(el.textContent, /^sushiconfidence 0\.21/);
  const b = bars(el);
  assert.deepEqual(b.map((n) => n.getAttribute('aria-label')), ['pizza 0.22', 'sushi 0.47', 'home 0.30']);
  assert.deepEqual(b.map((n) => n.vars.get('--w')), ['22.4%', '47.3%', '30.4%']);
  assert.ok(cls(b[1]).includes('opt-2'));
});

test('percent shows whole percents', () => {
  const el = choiceResult(choice, choiceAnswer, { percent: true });
  assert.equal(bars(el)[1].getAttribute('aria-label'), 'sushi 47\u00a0%');
  assert.match(el.textContent, /confidence 21\u00a0%/);
});

test('score: level text, marker, ends and one bar per level', () => {
  const el = scoreResult(score, scoreAnswer, {});
  assert.match(el.textContent, /2\.2 \u00b7 Today/);
  assert.equal(bars(el).length, 4);
  assert.equal(all(el, (n) => cls(n) === 'ms-mark')[0].vars.get('--at'), '68.2%');
  const ends = all(el, (n) => cls(n) === 'ms-ends')[0];
  assert.equal(ends.textContent, 'Not urgentNow');
  assert.ok(cls(bars(el)[0]).includes('lvl-1') && cls(bars(el)[3]).includes('lvl-4'));
});

test('noul: Yes from 0.5, the probability and the meter', () => {
  const yes = noulResult({}, { type: 'noul', noul: 0.5 }, {});
  assert.match(yes.textContent, /^Yes0\.50 yes/);
  const no = noulResult({}, { type: 'noul', noul: 0.34 }, {});
  assert.match(no.textContent, /^No0\.34 yes/);
  assert.equal(bars(no)[0].getAttribute('aria-label'), 'Yes 0.34');
  assert.equal(all(no, (n) => cls(n) === 'ms-meter__fill')[0].vars.get('--w'), '34.0%');
});

test('verdict: tinted by pick, with a check icon', () => {
  const v = guidedVerdict(choice, choiceAnswer);
  assert.ok(cls(v).includes('opt-2'));
  assert.equal(v.textContent, 'sushi');
  assert.ok(all(v, (n) => n.tagName === 'svg').length === 1);
  assert.equal(guidedVerdict(score, scoreAnswer).textContent, 'Today');
  assert.equal(guidedVerdict({ levels: [{ text: '1' }, { text: '2' }, { text: '3' }] }, { type: 'score', score: 2, probabilities: [0, 0, 1] }).textContent, '3');
  assert.equal(guidedVerdict({}, { type: 'noul', noul: 0.1 }).textContent, 'No');
});

test('no style attributes are ever set', () => {
  for (const el of [choiceResult(choice, choiceAnswer), scoreResult(score, scoreAnswer), noulResult({}, { type: 'noul', noul: 0.3 })]) {
    assert.equal(all(el, (n) => n.attributes.has('style')).length, 0);
  }
});

test('the captured responses draw without error', () => {
  const c = fixture('choice');
  assert.ok(choiceResult(c.run.questions[0], c.expected.answers.dinner, {}));
  const s = fixture('score');
  assert.ok(scoreResult(s.run.questions[0], s.expected.answers.urgency, {}));
});

test('deltas sit in a fourth column beside the numbers', () => {
  const el = choiceResult(choice, choiceAnswer, { deltas: [-0.4, 0, null] });
  const grid = all(el, (n) => cls(n).startsWith('ms-bars'))[0];
  assert.equal(cls(grid), 'ms-bars ms-bars--delta');
  const deltas = all(el, (n) => cls(n) === 'ms-bar__delta');
  assert.deepEqual(deltas.map((n) => n.textContent), ['−0.40', '0.00', '']);
  const s = scoreResult(score, scoreAnswer, { deltas: [0.1, null, null, null] });
  assert.equal(all(s, (n) => cls(n) === 'ms-bar__delta')[0].textContent, '+0.10');
  assert.equal(all(choiceResult(choice, choiceAnswer, {}), (n) => cls(n) === 'ms-bars ms-bars--delta').length, 0);
});

test('a choice can keep colours from another order', () => {
  const b = bars(choiceResult(choice, choiceAnswer, { colors: [2, 1, 0] }));
  assert.ok(cls(b[0]).includes('opt-3') && cls(b[2]).includes('opt-1'));
});

test('a score keeps level colours from another order', () => {
  const el = scoreResult(score, scoreAnswer, { colors: [3, 2, 1, 0] });
  const b = bars(el);
  assert.ok(cls(b[0]).includes('lvl-4') && cls(b[3]).includes('lvl-1'));
  const segs = all(el, (n) => cls(n) === 'ms-scale')[0].childNodes;
  assert.ok(cls(segs[0]).includes('lvl-4') && cls(segs[3]).includes('lvl-1'));
});

test('without the pick line only the bars with percentages remain', () => {
  const c = choiceResult(choice, choiceAnswer, { percent: true, pick: false });
  assert.equal(all(c, (n) => cls(n) === 'ms-pick').length, 0);
  assert.equal(c.textContent.includes('confidence'), false);
  assert.deepEqual(bars(c).map((n) => n.getAttribute('aria-label')), ['pizza 22 %', 'sushi 47 %', 'home 30 %']);
  const s = scoreResult(score, scoreAnswer, { percent: true, pick: false });
  assert.equal(all(s, (n) => cls(n) === 'ms-pick' || cls(n) === 'ms-mark' || cls(n) === 'ms-scale').length, 0);
  assert.equal(bars(s).length, 4);
  const y = noulResult({}, { type: 'noul', noul: 0.34 }, { percent: true, pick: false });
  assert.equal(all(y, (n) => cls(n) === 'ms-pick').length, 0);
  assert.equal(y.textContent, 'Yes34 %');
  assert.equal(bars(y)[0].getAttribute('aria-label'), 'Yes 34 %');
  assert.equal(all(y, (n) => cls(n) === 'ms-meter__fill')[0].vars.get('--w'), '34.0%');
});

test('the pick line shows the choice trimmed, as the option names are', () => {
  const el = choiceResult(choice, { ...choiceAnswer, choice: '  sushi \n' });
  assert.equal(all(el, (n) => cls(n) === 'ms-pick__name')[0].textContent, 'sushi');
});

test('verdict: a choice found after trimming takes its option colour', () => {
  const v = guidedVerdict({ options: [{ name: 'pizza' }, { name: ' sushi ' }] }, { ...choiceAnswer, choice: 'sushi ' });
  assert.ok(cls(v).includes('opt-2'));
  assert.equal(v.textContent, 'sushi');
});

test('verdict: a choice not among the options is neutral, not option 1', () => {
  const v = guidedVerdict(choice, { ...choiceAnswer, choice: 'tacos' });
  assert.ok(cls(v).includes('ms-neutral'));
  assert.ok(!/opt-\d/.test(cls(v)));
  assert.equal(v.textContent, 'tacos');
});

test('a score keeps A\'s level colours when B has fewer levels (colorCount)', () => {
  // B dropped A's second level: B's rows are A's levels 0, 2, 3 of 4.
  const three = { type: 'score', levels: [{ text: 'Not urgent' }, { text: 'Today' }, { text: 'Now' }] };
  const el = scoreResult(three, { type: 'score', score: 1, probabilities: [0.2, 0.5, 0.3], confidence: 0.5 }, { colors: [0, 2, 3], colorCount: 4 });
  const b = bars(el);
  assert.deepEqual(b.map((n) => cls(n).match(/lvl-\d/)[0]), ['lvl-1', 'lvl-3', 'lvl-4']);
});
