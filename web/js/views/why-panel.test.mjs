import assert from 'node:assert/strict';
import test from 'node:test';

// Like the DOM's NodeList: indexable and iterable, with forEach, but no array methods.
const NodeListProto = {
  item(i) { return this[i] ?? null; },
  forEach(fn) { for (let i = 0; i < this.length; i += 1) fn(this[i], i, this); },
  *[Symbol.iterator]() { for (let i = 0; i < this.length; i += 1) yield this[i]; },
};
const nodeList = (arr) => Object.assign(Object.create(NodeListProto), arr, { length: arr.length });

class FakeNode {
  constructor(tag, text) {
    this.tagName = tag;
    this.attributes = new Map();
    this.kids = [];
    this.parentNode = null;
    this.listeners = {};
    this.text = text ?? '';
    this.hidden = false;
    this.value = '';
    const node = this;
    this.classList = {
      add: (...c) => node.setAttribute('class', [...new Set([...(node.getAttribute('class') ?? '').split(' ').filter(Boolean), ...c])].join(' ')),
      contains: (c) => (node.getAttribute('class') ?? '').split(' ').includes(c),
    };
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'hidden') this.hidden = true;
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeNode('#text', n) : n;
      node.parentNode = this;
      this.kids.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const c of this.kids) c.parentNode = null;
    this.kids = [];
    this.append(...nodes);
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get options() { return this.kids.filter((c) => c.tagName === 'option'); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatch(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ type, target: this, preventDefault() {}, ...extra }); }
  focus() { globalThis.document.activeElement = this; }
  get childNodes() { return nodeList(this.kids); }
  get textContent() { return this.tagName === '#text' ? this.text : this.kids.map((c) => c.textContent).join(''); }
}
globalThis.document = {
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode('#text', text),
};

const { createWhyPanel, whyButton } = await import('./why-panel.js');
const { addWord, emptyWhy } = await import('../why.js');
const { RunError } = await import('../run-error.js');

const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.childNodes) all(c, pred, out); return out; };
const cls = (n) => n.getAttribute('class') ?? '';
const byClass = (root, c) => all(root, (n) => cls(n).split(' ').includes(c));
const visible = (root, node) => {
  for (let n = node; n && n !== root.parentNode; n = n.parentNode) if (n.hidden) return false;
  return true;
};
const shownText = (root) => {
  const walk = (n) => (n.hidden ? '' : n.tagName === '#text' ? n.text : [...n.childNodes].map(walk).join(''));
  return walk(root);
};
const buttonNamed = (root, name) => all(root, (n) => n.tagName === 'button' && n.textContent === name && visible(root, n))[0];
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const yes = { key: 'go', type: 'noul', text: 'Go?' };
const dinner = { key: 'dinner', type: 'choice', text: 'Dinner?', options: [{ name: 'pizza' }, { name: 'sushi' }] };
const baseAnswers = { go: { type: 'noul', noul: 0.7 }, dinner: { type: 'choice', choice: 'sushi', probabilities: [0.3, 0.7], confidence: 0.4 } };
const reduced = { answers: { go: { type: 'noul', noul: 0.4 }, dinner: { type: 'choice', choice: 'pizza', probabilities: [0.6, 0.4], confidence: 0.2 } } };

const entryOf = (state, questions = [yes], why) => ({
  id: 'e1',
  at: 0,
  guided: false,
  run: { questions, state },
  reply: { answers: Object.fromEntries(questions.map((q) => [q.key, baseAnswers[q.key]])) },
  totalMs: 10,
  why,
});

// A part measured for `done` words, each moving every answer as `reduced` does.
const partOf = (entry, done) => {
  let why = emptyWhy(entry.run);
  for (let i = 0; i < done; i += 1) why = addWord(why, entry.run, entry.reply.answers, reduced.answers);
  return why;
};

function fakeClient(reply = () => reduced) {
  const sent = [];
  return {
    sent,
    async why(run) {
      sent.push(run);
      await Promise.resolve();
      return reply(sent.length - 1);
    },
  };
}
function fakeSave() {
  const parts = [];
  return { parts, save: async (why) => { parts.push(why); } };
}

const panel = (entry, client = fakeClient(), save = fakeSave(), extra = {}) =>
  createWhyPanel({ client, entry, save: save.save, onBack: () => {}, ...extra });
const head = (el) => byClass(el, 'ms-why__head')[0].textContent;

test('no button without the feature or without a saved entry', () => {
  assert.equal(whyButton({ entry: entryOf('a b'), why: null, onOpen() {} }), null);
  assert.equal(whyButton({ entry: null, why: { maxWords: 50 }, onOpen() {} }), null);
});

test('the button names the cost', () => {
  let opened = 0;
  const el = whyButton({ entry: entryOf(words(11)), why: { maxWords: 50 }, onOpen: () => (opened += 1) });
  const button = buttonNamed(el, 'Why?');
  assert.equal(button.getAttribute('disabled'), null);
  assert.match(el.textContent, /asks 11 more times, once per word$/);
  button.dispatch('click');
  assert.equal(opened, 1);
});

test('over the limit the button is disabled with the reason', () => {
  const el = whyButton({ entry: entryOf(words(11)), why: { maxWords: 5 }, onOpen() {} });
  const button = buttonNamed(el, 'Why?');
  assert.notEqual(button.getAttribute('disabled'), null);
  assert.match(el.textContent, /Why\? works up to 5 words; this situation has 11\.$/);
  const empty = whyButton({ entry: entryOf('  '), why: { maxWords: 5 }, onOpen() {} });
  assert.match(empty.textContent, /Why\? needs a situation\.$/);
});

test('with a kept part the panel shows it and asks nothing', async () => {
  const entry = entryOf('a b c');
  entry.why = partOf(entry, 3);
  const note = whyButton({ entry, why: { maxWords: 50 }, onOpen() {} });
  assert.equal(note.textContent, 'Why?');
  const client = fakeClient();
  const { el } = panel(entry, client);
  await settle();
  assert.equal(client.sent.length, 0);
  assert.equal(head(el), 'What each word did to the answer');
  assert.equal(byClass(el, 'ms-why__text')[0].textContent, 'a b c');
  assert.ok(visible(el, byClass(el, 'ms-why__legend')[0]));
  assert.match(shownText(el), /Strongest words · yes was 70 %/);
  assert.ok(buttonNamed(el, 'Back to result') && buttonNamed(el, 'Ask again'));
  assert.equal(buttonNamed(el, 'Stop'), undefined);
});

test('a kept part that does not fit is ignored and a run starts', async () => {
  const entry = entryOf('a b c');
  entry.why = { ...partOf(entry, 3), words: 4 };
  const client = fakeClient();
  const save = fakeSave();
  const { el } = panel(entry, client, save);
  assert.equal(head(el), 'Leaving out one word at a time');
  assert.ok(buttonNamed(el, 'Stop'));
  await settle();
  assert.equal(client.sent.length, 3);
  assert.equal(head(el), 'What each word did to the answer');
  assert.deepEqual(save.parts.map((p) => p.done), [3]);
});

test('while running the word being asked is marked and the count shown', async () => {
  let release;
  const client = fakeClient((i) => (i === 1 ? new Promise((r) => (release = () => r(reduced))) : reduced));
  const { el } = panel(entryOf('a b c'), client);
  await settle();
  const out = byClass(el, 'ms-why__w--out');
  assert.equal(out.length, 1);
  assert.equal(out[0].textContent, 'b');
  assert.match(shownText(el), /word 2 of 3/);
  release();
  await settle();
  assert.equal(head(el), 'What each word did to the answer');
});

test('a stopped part shows how far it got', async () => {
  const entry = entryOf(words(11));
  entry.why = partOf(entry, 6);
  const client = fakeClient();
  const { el } = panel(entry, client);
  await settle();
  assert.equal(client.sent.length, 0);
  assert.equal(head(el), 'Stopped after 6 of 11 words');
});

test('Ask again replaces the kept part', async () => {
  const entry = entryOf('a b c');
  entry.why = partOf(entry, 2);
  const client = fakeClient();
  const save = fakeSave();
  const { el } = panel(entry, client, save);
  assert.equal(head(el), 'Stopped after 2 of 3 words');
  buttonNamed(el, 'Ask again').dispatch('click');
  assert.equal(head(el), 'Leaving out one word at a time');
  await settle();
  assert.deepEqual(client.sent.map((r) => r.state), ['b c', 'a c', 'a b']);
  assert.deepEqual(save.parts.map((p) => p.done), [3]);
  assert.equal(head(el), 'What each word did to the answer');
});

test('close during a run stops it and saves what was measured', async () => {
  let release;
  const client = fakeClient((i) => (i === 2 ? new Promise((r) => (release = () => r(reduced))) : reduced));
  const save = fakeSave();
  const p = panel(entryOf('a b c d'), client, save);
  await settle();
  assert.equal(client.sent.length, 3);
  p.close();
  release();
  await settle();
  assert.equal(client.sent.length, 3);
  assert.deepEqual(save.parts.map((x) => x.done), [2]);
  assert.equal(head(p.el), 'Leaving out one word at a time', 'a closed panel is not redrawn');
});

test('a failed run shows its sentence', async () => {
  const client = fakeClient(() => { throw new RunError('Too many questions.', 'limit'); });
  const { el } = panel(entryOf('a b'), client);
  await settle();
  assert.equal(head(el), 'Stopped after 0 of 2 words');
  assert.equal(byClass(el, 'oc-notice--danger')[0].textContent, 'Too many questions.');
});

test('the question select switches what is shown', async () => {
  const entry = entryOf('a b', [dinner, yes]);
  entry.why = partOf(entry, 2);
  const { el } = panel(entry);
  const select = all(el, (n) => n.tagName === 'select')[0];
  assert.equal(select.getAttribute('aria-label'), 'Question');
  assert.deepEqual(select.options.map((o) => o.textContent), ['Dinner?', 'Go?']);
  const legendText = () => byClass(el, 'ms-why__legend')[0].textContent;
  assert.match(legendText(), /^pulled towards sushi/);
  assert.match(shownText(el), /sushi was 70 %/);
  select.value = 'go';
  select.dispatch('change');
  assert.match(legendText(), /^towards yes/);
  assert.match(shownText(el), /yes was 70 %/);
  assert.equal(all(panel(entryOf('a', [yes], partOf(entryOf('a'), 1))).el, (n) => n.tagName === 'select').length, 0);
});

test('activating a word writes its numbers under the text', () => {
  const entry = entryOf('a b');
  entry.why = partOf(entry, 2);
  const { el } = panel(entry);
  const word = all(byClass(el, 'ms-why__text')[0], (n) => n.tagName === 'button')[1];
  word.dispatch('click');
  const detail = byClass(el, 'ms-why__detail')[0];
  assert.equal(detail.getAttribute('aria-live'), 'polite');
  assert.equal(detail.textContent, 'without it: yes 70 % → 40 % (−30), answer becomes No');
});

test('focus on a word button survives a runner update and the rest is still drawn', async () => {
  let release;
  const client = fakeClient((i) => (i === 2 ? new Promise((r) => (release = () => r(reduced))) : reduced));
  const { el } = panel(entryOf('a b c'), client);
  await settle();
  const text = () => byClass(el, 'ms-why__text')[0];
  const b = all(text(), (n) => n.tagName === 'button' && n.textContent === 'b')[0];
  b.focus();
  release();
  await settle();
  const now = document.activeElement;
  assert.notEqual(now, b, 'the text was redrawn');
  assert.ok(text().contains(now));
  assert.equal(now.getAttribute('data-i'), '1');
  assert.equal(now.getAttribute('tabindex'), '0');
  assert.equal(head(el), 'What each word did to the answer');
  assert.ok(buttonNamed(el, 'Ask again'));
  assert.equal(buttonNamed(el, 'Stop'), undefined);
  assert.ok(visible(el, byClass(el, 'ms-why__legend')[0]));
});
