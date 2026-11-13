// History: the runs asked so far, newest first. A row opens at #/history/<id> with the situation,
// every question's result, the run line and the request and response; from there a run goes
// back to the bench (as baseline A), back into the guide, or away. Deleting and clearing act at
// once with an undo notice.
import { messageOf } from '../run-error.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { resultsSection } from './bench-results.js';
import { queueRun } from './bench-model.js';
import { loadable, queueGuidedRun } from './guided-model.js';
import { benchResult, createHistoryModel, formatWhen, headline } from './history-model.js';

const LIST = '#/history';
const hrefOf = (id) => `${LIST}/${encodeURIComponent(id)}`;

export function createHistoryView({ now = () => new Date() } = {}) {
  let root = null;
  let ctx = null;
  let model = null;
  let modelStore = null;
  let off = null;
  let openId = null;
  let showIO = false;
  let loaded = false;

  const notify = (text, opts) => ctx.notify(text, opts);
  const fail = (e) => notify(messageOf(e), { kind: 'danger' });

  function undoNotice(text, undo) {
    notify(text, {
      action: {
        label: 'Undo',
        run: async () => {
          try {
            await undo();
          } catch (e) {
            fail(e);
          }
        },
      },
    });
  }

  async function remove(entry) {
    let undo;
    try {
      undo = await model.remove(entry.id);
    } catch (e) {
      fail(e);
      return;
    }
    undoNotice(`Deleted '${headline(entry).text}'`, undo);
    ctx.navigate(LIST);
  }

  async function clear() {
    const n = model.entries().length;
    if (n === 0) return;
    try {
      undoNotice(`Cleared ${n} ${n === 1 ? 'entry' : 'entries'}`, await model.clear());
    } catch (e) {
      fail(e);
    }
  }

  const act = (label, fn, cls = 'oc-btn') => h('button', { type: 'button', class: cls, onclick: fn }, label);

  function row(entry) {
    const { text, answer, cls } = headline(entry);
    const more = entry.run.questions.length - 1;
    return h('li', {},
      h('a', { class: 'ms-hrow', href: hrefOf(entry.id), 'data-entry': entry.id },
        h('span', { class: 'ms-hrow__text' }, text),
        answer ? h('span', { class: `ms-chip ms-hrow__chip ${cls}` }, answer) : null,
        more > 0 ? h('span', { class: 'ms-hrow__more' }, `+${more}`) : null,
        h('span', { class: 'ms-hrow__ms' }, `${Math.round(entry.totalMs)} ms`),
        h('span', { class: 'ms-hrow__when' }, formatWhen(entry.at, now())),
      ),
    );
  }

  function renderList() {
    const entries = model.entries();
    root.replaceChildren(
      h('header', { class: 'oc-page-head' },
        h('h1', { class: 'oc-text-page', tabindex: '-1' }, 'History'),
        entries.length ? act('Clear history', clear) : null,
      ),
      entries.length
        ? h('ul', { class: 'ms-hlist' }, entries.map(row))
        : h('div', { class: 'ms-hempty' },
            h('p', { class: 'ms-empty' }, 'Nothing asked yet.'),
            act('Ask a question', () => ctx.navigate('#/ask'), 'oc-btn oc-btn--primary')),
    );
  }

  function openInBench(entry) {
    queueRun(entry.run, benchResult(entry));
    ctx.navigate('#/ask/bench');
  }

  // A run the guide cannot take (more than one question) opens in the bench instead.
  function askAgain(entry) {
    if (!loadable(entry.run)) {
      openInBench(entry);
      return;
    }
    queueGuidedRun(entry.run);
    ctx.navigate('#/ask');
  }

  function renderEntry(entry) {
    const state = { resultA: benchResult(entry), ranA: entry.run, resultB: null, ranB: null, variant: null };
    const view = {
      mode: ctx.mode,
      showIO,
      notify,
      toggleIO() {
        showIO = !showIO;
        renderEntry(entry);
        root.querySelector('[data-fid="io"]')?.focus({ preventScroll: true });
      },
    };
    root.replaceChildren(
      h('header', { class: 'oc-page-head' },
        h('h1', { class: 'oc-text-page', tabindex: '-1' }, 'History'),
        h('a', { class: 'oc-btn', href: LIST }, 'Back'),
      ),
      h('div', { class: 'oc-stack ms-hentry' },
        h('div', { class: 'ms-hentry__when' }, formatWhen(entry.at, now())),
        entry.run.state.trim() ? h('pre', { class: 'ms-hentry__state' }, entry.run.state) : null,
        ...resultsSection(state, null, view),
        h('div', { class: 'oc-row ms-actions' },
          act('Open in bench', () => openInBench(entry), 'oc-btn oc-btn--primary'),
          entry.guided ? act('Ask again', () => askAgain(entry)) : null,
          act('Delete', () => remove(entry)),
        ),
      ),
    );
  }

  // The list could not be read: the heading and the sentence, in place of the list.
  function renderFailed(e) {
    root.replaceChildren(
      h('header', { class: 'oc-page-head' }, h('h1', { class: 'oc-text-page', tabindex: '-1' }, 'History')),
      h('div', { class: 'oc-notice oc-notice--danger ms-inline-notice', role: 'alert' }, icon('danger'), h('span', { class: 'oc-notice__text' }, messageOf(e))),
    );
  }

  function render() {
    if (!root || !loaded) return;
    const entry = openId ? model.find(openId) : null;
    if (entry) renderEntry(entry);
    else renderList();
  }

  return {
    mount(el, c) {
      root = el;
      ctx = c;
      openId = c.route?.id ?? null;
      showIO = false;
      loaded = false;
      // One model per store: an undo that finishes after leaving still updates the next mount.
      if (!model || modelStore !== ctx.store) {
        model = createHistoryModel(ctx.store);
        modelStore = ctx.store;
      }
      off = model.subscribe(() => render());
      model.load().then(() => {
        loaded = true;
        render();
      }).catch((e) => {
        if (root === el) renderFailed(e);
      });
    },
    unmount() {
      // ctx stays: an Undo still in flight finishes against the store after leaving.
      off?.();
      root = null;
    },
  };
}
