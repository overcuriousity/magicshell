import assert from 'node:assert/strict';
import test from 'node:test';
import { notify } from './notice.js';

// Just enough of the DOM for h() and icon(): elements with attributes, children and listeners.
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

const setup = (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  return new FakeNode('div');
};
const button = (region) => region.find((n) => n.tagName === 'button');

test('a notice shows a symbol and the text, and hides after 6000 ms, not at 5999', (t) => {
  const region = setup(t);
  notify('Saved', { region });
  assert.equal(region.childNodes.length, 1);
  assert.equal(region.textContent, 'Saved');
  assert.ok(region.find((n) => n.tagName === 'svg'), 'has a status symbol');
  t.mock.timers.tick(5999);
  assert.equal(region.childNodes.length, 1);
  t.mock.timers.tick(1);
  assert.equal(region.childNodes.length, 0);
});

test('the action runs once and dismisses the notice', (t) => {
  const region = setup(t);
  let runs = 0;
  notify("Deleted 'x'", { region, action: { label: 'Undo', run: () => runs++ } });
  const b = button(region);
  assert.equal(b.textContent, 'Undo');
  b.dispatch('click');
  b.dispatch('click');
  assert.equal(runs, 1);
  assert.equal(region.childNodes.length, 0);
});

test('a notice pauses while hovered or focused', (t) => {
  const region = setup(t);
  notify('Deleted', { region, ms: 6000 });
  const el = region.childNodes[0];
  t.mock.timers.tick(2000);
  el.dispatch('mouseenter');
  t.mock.timers.tick(10000);
  assert.equal(region.childNodes.length, 1);
  el.dispatch('focusin');
  el.dispatch('mouseleave');
  t.mock.timers.tick(10000);
  assert.equal(region.childNodes.length, 1, 'still focused');
  el.dispatch('focusout', { relatedTarget: null });
  t.mock.timers.tick(3999);
  assert.equal(region.childNodes.length, 1);
  t.mock.timers.tick(1);
  assert.equal(region.childNodes.length, 0);
});

test('dismiss removes the notice at once and only once', (t) => {
  const region = setup(t);
  const n = notify('Copied', { region, ms: 1500 });
  n.dismiss();
  n.dismiss();
  assert.equal(region.childNodes.length, 0);
  t.mock.timers.tick(2000);
});
