import assert from 'node:assert/strict';
import test from 'node:test';
import { route } from './app.js';

test('an empty hash opens Ask', () => {
  assert.deepEqual(route(''), { view: 'ask' });
  assert.deepEqual(route('#'), { view: 'ask' });
  assert.deepEqual(route('#/'), { view: 'ask' });
});

test('each destination has its own route', () => {
  for (const view of ['ask', 'history', 'setups', 'settings', 'sign-in']) {
    assert.deepEqual(route(`#/${view}`), { view });
  }
});

test('a second segment is the id', () => {
  assert.deepEqual(route('#/history/abc'), { view: 'history', id: 'abc' });
  assert.deepEqual(route('#/setups/my%20setup'), { view: 'setups', id: 'my setup' });
});

test('an unknown route opens Ask', () => {
  assert.deepEqual(route('#/nope'), { view: 'ask' });
  assert.deepEqual(route('#/nope/abc'), { view: 'ask' });
  assert.deepEqual(route('history'), { view: 'ask' });
});

test('the bench lives under Ask', () => {
  assert.deepEqual(route('#/ask/bench'), { view: 'ask', id: 'bench' });
});

// A tiny DOM for the top-bar switch link; set after app.js is loaded so it does not boot.
const fakeEl = (tag) => {
  const el = {
    tagName: tag,
    attrs: {},
    children: [],
    listeners: {},
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute: (k) => el.attrs[k] ?? null,
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    append(...c) { el.children.push(...c); },
    replaceChildren(...c) { el.children = c; },
    click(extra = {}) { for (const fn of el.listeners.click ?? []) fn({ button: 0, ...extra }); },
  };
  return el;
};

const { createAskView } = await import('./app.js');

const fakeSide = (run) => {
  const seen = [];
  return { seen, mount(_el, ctx) { seen.push(ctx.carry); this.ctx = ctx; }, unmount() {}, currentRun: () => run };
};

test('the guided view opens at #/ask and the bench at #/ask/bench', () => {
  globalThis.document = { createElement: fakeEl };
  const guided = fakeSide(null);
  const bench = fakeSide(null);
  const ask = createAskView({ guided, bench });
  const slot = fakeEl('div');
  ask.mount({}, { route: { view: 'ask' }, modeSwitch: slot, navigate() {} });
  assert.equal(guided.seen.length, 1);
  assert.equal(slot.children[0].attrs.href, '#/ask/bench');
  assert.equal(slot.children[0].children[0], 'Bench');
  ask.unmount();
  assert.equal(slot.children.length, 0);
  ask.mount({}, { route: { view: 'ask', id: 'bench' }, modeSwitch: slot, navigate() {} });
  assert.equal(bench.seen.length, 1);
  assert.equal(slot.children[0].attrs.href, '#/ask');
  assert.equal(slot.children[0].children[0], 'Guided view');
});

test('switching carries the entered run to the other side, once', () => {
  globalThis.document = { createElement: fakeEl };
  const run = { state: 'Rain.', questions: [{ key: 'q1', type: 'noul', text: 'Wet?' }] };
  const guided = fakeSide(run);
  const bench = fakeSide({ state: '', questions: [] });
  const ask = createAskView({ guided, bench });
  const slot = fakeEl('div');
  ask.mount({}, { route: { view: 'ask' }, modeSwitch: slot, navigate() {} });
  slot.children[0].click();
  ask.unmount();
  ask.mount({}, { route: { view: 'ask', id: 'bench' }, modeSwitch: slot, navigate() {} });
  assert.deepEqual(bench.seen, [run]);
  ask.unmount();
  ask.mount({}, { route: { view: 'ask', id: 'bench' }, modeSwitch: slot, navigate() {} });
  assert.deepEqual(bench.seen, [run, null]);
});

test('something else in the guide opens the bench with the run it hands over', () => {
  globalThis.document = { createElement: fakeEl };
  const guided = fakeSide(null);
  const bench = fakeSide(null);
  const ask = createAskView({ guided, bench });
  const went = [];
  ask.mount({}, { route: { view: 'ask' }, modeSwitch: fakeEl('div'), navigate: (h) => went.push(h) });
  const empty = { state: '', questions: [{ key: 'q1', type: 'noul', text: '' }] };
  guided.ctx.toBench(empty);
  assert.deepEqual(went, ['#/ask/bench']);
  ask.unmount();
  ask.mount({}, { route: { view: 'ask', id: 'bench' }, modeSwitch: fakeEl('div'), navigate() {} });
  assert.deepEqual(bench.seen, [empty]);
});

test('a modifier-click on the switch carries nothing', () => {
  globalThis.document = { createElement: fakeEl };
  const run = { state: '', questions: [{ key: 'q1', type: 'noul', text: 'Wet?' }] };
  const guided = fakeSide(run);
  const bench = fakeSide(null);
  const ask = createAskView({ guided, bench });
  const slot = fakeEl('div');
  ask.mount({}, { route: { view: 'ask' }, modeSwitch: slot, navigate() {} });
  slot.children[0].click({ ctrlKey: true });
  slot.children[0].click({ button: 1 });
  ask.unmount();
  ask.mount({}, { route: { view: 'ask', id: 'bench' }, modeSwitch: slot, navigate() {} });
  assert.deepEqual(bench.seen, [null]);
});
