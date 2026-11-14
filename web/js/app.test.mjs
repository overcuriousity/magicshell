import assert from 'node:assert/strict';
import test from 'node:test';
import { route } from './app.js';

test('servicesFor passes preheat through, true only for true', async () => {
  const { servicesFor } = await import('./app.js');
  for (const mode of ['open', 'accounts']) {
    assert.equal(servicesFor({ mode, model: 'm', user: null, version: null, why: null, preheat: true }).preheat, true);
    assert.equal(servicesFor({ mode, model: 'm', user: null, version: null, why: null, preheat: false }).preheat, false);
    assert.equal(servicesFor({ mode, model: 'm', user: null, version: null, why: null }).preheat, false);
  }
});

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
    append(...c) { el.children.push(...c.map((n) => (n !== null && typeof n === 'object' ? n : String(n)))); },
    replaceChildren(...c) { el.children = c.map((n) => (n !== null && typeof n === 'object' ? n : String(n))); },
    click(extra = {}) { for (const fn of el.listeners.click ?? []) fn({ button: 0, ...extra }); },
  };
  return el;
};

const { createAskView } = await import('./app.js');
const { takeRun } = await import('./views/bench-model.js');
const { loadable, takeGuidedRun } = await import('./views/guided-model.js');

// A side that keeps a draft and takes what is handed to it the way the real views do: the bench
// takes any run, the guide only one it can ask (and keeps its own draft otherwise).
// The guide also hands nothing back right after refusing a run, until something changes.
const fakeSide = (draft, take, canTake = () => true) => {
  const seen = [];
  let refused = false;
  const side = {
    seen,
    draft,
    mount(_el, ctx) {
      const handed = take ? take() : null;
      refused = Boolean(handed) && !canTake(handed);
      seen.push(refused ? 'refused' : handed);
      if (handed && !refused) side.draft = handed;
      side.ctx = ctx;
    },
    unmount() {},
    currentRun: () => (refused ? null : side.draft),
  };
  return side;
};
const benchSide = (draft) => fakeSide(draft, () => takeRun()?.run ?? null);
const guidedSide = (draft) => fakeSide(draft, takeGuidedRun, loadable);
const at = (id) => ({ route: id ? { view: 'ask', id } : { view: 'ask' } });

test('the guided view opens at #/ask and the bench at #/ask/bench', () => {
  globalThis.document = { createElement: fakeEl };
  const guided = guidedSide(null);
  const bench = benchSide(null);
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
  const guided = guidedSide(run);
  const bench = benchSide(null);
  const ask = createAskView({ guided, bench });
  const slot = fakeEl('div');
  ask.mount({}, { ...at(), modeSwitch: slot, navigate() {} });
  slot.children[0].click();
  ask.unmount();
  ask.mount({}, { ...at('bench'), modeSwitch: slot, navigate() {} });
  assert.deepEqual(bench.seen, [run]);
  ask.unmount();
  ask.mount({}, { ...at('bench'), modeSwitch: slot, navigate() {} });
  assert.deepEqual(bench.seen, [run, null]);
});

test('a round trip bench, guide, bench keeps both drafts', () => {
  globalThis.document = { createElement: fakeEl };
  const several = {
    state: 'Ticket.',
    questions: [{ key: 'urgent', type: 'noul', text: 'Urgent?' }, { key: 'angry', type: 'noul', text: 'Angry?' }],
  };
  const guideDraft = { state: 'Context.', questions: [{ key: 'q1', type: 'noul', text: 'Mine?' }] };
  for (const draft of [null, guideDraft]) {
    const guided = guidedSide(draft);
    const bench = benchSide(several);
    const ask = createAskView({ guided, bench });
    const slot = fakeEl('div');
    ask.mount({}, { ...at('bench'), modeSwitch: slot, navigate() {} });
    slot.children[0].click();
    ask.unmount();
    // Several questions cannot be asked in the guide: it keeps its own draft.
    ask.mount({}, { ...at(), modeSwitch: slot, navigate() {} });
    assert.deepEqual(guided.seen, ['refused']);
    assert.equal(guided.draft, draft);
    slot.children[0].click();
    ask.unmount();
    // Straight back: nothing is handed over, the bench keeps its several questions.
    ask.mount({}, { ...at('bench'), modeSwitch: slot, navigate() {} });
    assert.deepEqual(bench.seen, [null, null]);
    assert.equal(bench.draft, several);
    ask.unmount();
  }
});

test('switching to the bench from an empty guide leaves the bench as it was', () => {
  globalThis.document = { createElement: fakeEl };
  const kept = { state: '', questions: [{ key: 'a', type: 'noul', text: 'A?' }, { key: 'b', type: 'noul', text: 'B?' }] };
  const guided = guidedSide(null);
  const bench = benchSide(kept);
  const ask = createAskView({ guided, bench });
  const slot = fakeEl('div');
  ask.mount({}, { ...at(), modeSwitch: slot, navigate() {} });
  slot.children[0].click();
  ask.unmount();
  ask.mount({}, { ...at('bench'), modeSwitch: slot, navigate() {} });
  assert.deepEqual(bench.seen, [null]);
  assert.equal(bench.draft, kept);
});

test('something else in the guide opens the bench as it was left', () => {
  globalThis.document = { createElement: fakeEl };
  const guided = guidedSide(null);
  const bench = benchSide(null);
  const ask = createAskView({ guided, bench });
  const went = [];
  ask.mount({}, { ...at(), modeSwitch: fakeEl('div'), navigate: (h) => went.push(h) });
  guided.ctx.toBench();
  assert.deepEqual(went, ['#/ask/bench']);
  ask.unmount();
  ask.mount({}, { ...at('bench'), modeSwitch: fakeEl('div'), navigate() {} });
  assert.deepEqual(bench.seen, [null]);
});

test('a modifier-click on the switch carries nothing', () => {
  globalThis.document = { createElement: fakeEl };
  const run = { state: '', questions: [{ key: 'q1', type: 'noul', text: 'Wet?' }] };
  const guided = guidedSide(run);
  const bench = benchSide(null);
  const ask = createAskView({ guided, bench });
  const slot = fakeEl('div');
  ask.mount({}, { ...at(), modeSwitch: slot, navigate() {} });
  slot.children[0].click({ ctrlKey: true });
  slot.children[0].click({ button: 1 });
  ask.unmount();
  ask.mount({}, { ...at('bench'), modeSwitch: slot, navigate() {} });
  assert.deepEqual(bench.seen, [null]);
});

const { showsNotSaving } = await import('./app.js');

test('the not-saving notice is for browser storage only', () => {
  assert.equal(showsNotSaving({ mode: 'open', storage: null, store: { persistent: true } }), true);
  assert.equal(showsNotSaving({ mode: 'open', storage: {}, store: { persistent: false } }), true);
  assert.equal(showsNotSaving({ mode: 'open', storage: {}, store: { persistent: true } }), false);
  assert.equal(showsNotSaving({ mode: 'accounts', storage: null, store: { persistent: true } }), false);
});

test('the sentence for a trimmed history names how many entries went', async () => {
  const { trimmedSentence } = await import('./app.js');
  assert.equal(trimmedSentence(1), 'This browser is out of room, so History removed its oldest entry. It keeps making room this way.');
  assert.equal(trimmedSentence(3), 'This browser is out of room, so History removed its 3 oldest entries. It keeps making room this way.');
});

test('services carry the why limit in accounts mode only', async () => {
  const { servicesFor } = await import('./app.js');
  const why = { maxWords: 300 };
  assert.deepEqual(servicesFor({ mode: 'accounts', model: 'm', user: null, version: null, why }).why, why);
  assert.equal(servicesFor({ mode: 'open', model: 'm', user: null, version: null, why }).why, null);
});

test('services carry single sign-on in accounts mode only', async () => {
  const { servicesFor } = await import('./app.js');
  const sso = { label: 'Sign in with SSO' };
  assert.deepEqual(servicesFor({ mode: 'accounts', model: 'm', user: null, version: null, why: null, sso }).sso, sso);
  assert.equal(servicesFor({ mode: 'accounts', model: 'm', user: null, version: null, why: null }).sso, null);
  assert.equal(servicesFor({ mode: 'open', model: 'm', user: null, version: null, why: null, sso }).sso, null);
});

test('the accounts-mode store offers suggestions, stays persistent and leads to Sign in when the session ran out', async () => {
  const { serverStore } = await import('./app.js');
  const { RunError } = await import('./run-error.js');
  const fetchFn = async () => ({ ok: false, status: 401, text: async () => 'Sign in first.' });
  let lost = 0;
  const store = serverStore(fetchFn, () => { lost += 1; });
  assert.equal(typeof store.suggest?.load, 'function');
  assert.equal(typeof store.suggest?.current, 'function');
  assert.equal(store.persistent, true);
  await assert.rejects(store.listSetups(), (e) => e instanceof RunError && e.kind === 'auth');
  assert.equal(lost, 1);
  // A write goes through both wraps and still reaches the handler.
  await assert.rejects(store.saveEntry({ id: 'x' }), (e) => e instanceof RunError && e.kind === 'auth');
  assert.equal(lost, 2);
});

test('accounts mode can sign in with a password with or without single sign-on', async () => {
  const { accountsActions } = await import('./app.js');
  for (const sso of [null, { label: 'x' }]) {
    const services = { mode: 'accounts', sso, user: null, client: { signIn: async () => {} } };
    const went = [];
    const deps = {
      userChanged: async () => { services.user = { username: 'ada', password: true }; },
      navigate: (hash) => went.push(hash),
      asked: () => '#/history',
      session: null,
    };
    const { signIn, signOut } = accountsActions(services, deps);
    assert.equal(typeof signIn, 'function');
    assert.equal(typeof signOut, 'function');
    await signIn('ada', 'pw');
    assert.deepEqual(went, ['#/history']);
  }
});

test('signing out marks the tab as checked so no silent trip follows', async () => {
  const { accountsActions } = await import('./app.js');
  const { SSO_CHECKED } = await import('./sso.js');
  const stored = new Map();
  const session = { setItem: (k, v) => stored.set(k, v) };
  const services = { mode: 'accounts', sso: { label: 'x' }, user: null, client: { signOut: async () => {} } };
  const went = [];
  const { signOut } = accountsActions(services, { userChanged: async () => {}, navigate: (h) => went.push(h), asked: () => '#/ask', session });
  await signOut();
  assert.equal(stored.get(SSO_CHECKED), '#/ask');
  assert.deepEqual(went, ['#/ask']);
});
