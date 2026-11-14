// Why?: the button under a saved result, and the panel that runs the word-by-word asking and
// shows the marked text, its legend and the strongest words. The views mount the panel's one
// element and keep it across their own re-renders; close() when it goes away.
import { h } from '../ui/dom.js';
import { picker } from '../ui/menu.js';
import { inlineError } from '../ui/notice.js';
import { rove, whyLegend, whyTable, whyTableLabel, whyText } from '../ui/why-text.js';
import { canAsk, costNote, fits, splitWords } from '../why.js';
import { createWhyRunner } from './why-runner.js';

let uid = 0;

// why is ctx.why ({ maxWords } or null). A kept part that fits opens without asking, so no cost is named.
export function whyButton({ entry, why, onOpen }) {
  if (!why || !entry) return null;
  const kept = fits(entry.why, entry.run);
  const check = canAsk(entry.run, why.maxWords, entry.guided === true);
  const ok = kept || check.ok;
  const noteId = `ms-why-note-${++uid}`;
  const note = kept ? null : h('span', { class: 'ms-why__note', id: noteId }, ok ? costNote(check.count) : check.reason);
  const button = h('button', { type: 'button', class: 'oc-btn', disabled: !ok, 'aria-describedby': note ? noteId : null, onclick: onOpen }, 'Why?');
  return h('div', { class: 'oc-row ms-why-ask' }, button, note);
}

const HEAD_RUNNING = 'Leaving out one word at a time';
const HEAD_DONE = 'What each word did to the answer';

const wordButtons = (text) =>
  [...text.childNodes].filter((n) => typeof n.getAttribute === 'function' && n.getAttribute('data-i') !== null);

export function createWhyPanel({ client, entry, save, onBack, onAuth }) {
  const { run } = entry;
  const base = entry.reply.answers;
  const total = splitWords(run.state).length;
  let key = run.questions[0].key;
  let view = { phase: 'running', at: null, why: null, error: null };
  let closed = false;

  const runner = createWhyRunner({ client, entry, save, onAuth });
  const off = runner.subscribe((s) => {
    view = s;
    draw();
  });

  const head = h('p', { class: 'oc-label ms-why__head', 'aria-live': 'polite' });
  const textHost = h('div', { class: 'ms-why__body' });
  const detail = h('p', { class: 'ms-why__detail', 'aria-live': 'polite' });
  const progress = h('span', { class: 'ms-why__note' });
  const stop = h('button', { type: 'button', class: 'oc-btn', onclick: () => runner.stop() }, 'Stop');
  const running = h('div', { class: 'oc-row' }, stop, progress);
  const legendHost = h('div');
  const errorHost = h('div');
  const tableHost = h('div', { class: 'ms-why__top' });
  const again = h('button', { type: 'button', class: 'oc-btn', onclick: () => { ask(); stop.focus?.(); } }, 'Ask again');
  const back = h('button', { type: 'button', class: 'oc-btn', onclick: () => onBack() }, 'Back to result');
  const actions = h('div', { class: 'oc-row ms-actions' }, back, again);

  let questionField = null;
  if (run.questions.length > 1) {
    const select = h(
      'select',
      { 'aria-label': 'Question', onchange: () => { key = select.value; detail.replaceChildren(); draw(); } },
      run.questions.map((q) => h('option', { value: q.key, selected: q.key === key }, q.text || q.key)),
    );
    questionField = h('div', { class: 'oc-field ms-why__question' }, h('span', { class: 'oc-field__label', 'aria-hidden': 'true' }, 'Question'), picker(select));
  }

  const el = h(
    'section',
    { class: 'ms-why', 'aria-label': 'Why?' },
    head,
    questionField,
    h('div', { class: 'ms-why__card' }, textHost, detail, running, legendHost),
    errorHost,
    tableHost,
    actions,
  );

  function drawText(isRunning) {
    const focused = document.activeElement;
    const was = focused && textHost.contains(focused) ? focused.getAttribute('data-i') : null;
    const text = whyText({ run, base, why: view.why, key, at: isRunning ? view.at : null, onWord: (t) => detail.replaceChildren(t) });
    textHost.replaceChildren(text);
    if (was === null) return;
    const buttons = wordButtons(text);
    const i = buttons.findIndex((b) => b.getAttribute('data-i') === was);
    if (i < 0) return;
    rove(buttons, i);
    buttons[i].focus();
  }

  // A live region is told only what changed: the same text is left as it is.
  const setText = (el, text) => {
    if (el.textContent !== text) el.replaceChildren(text);
  };

  function draw() {
    if (closed) return;
    const isRunning = view.phase === 'running';
    const done = view.why?.done ?? 0;
    const question = run.questions.find((q) => q.key === key);
    setText(head, isRunning ? HEAD_RUNNING : view.phase === 'done' ? HEAD_DONE : `Stopped after ${done} of ${total} words`);
    drawText(isRunning);
    running.hidden = !isRunning;
    setText(progress, `word ${Math.min((view.at ?? done) + 1, total)} of ${total}`);
    legendHost.hidden = isRunning;
    legendHost.replaceChildren(whyLegend(question, base[key]));
    errorHost.replaceChildren(...(view.error ? [inlineError(view.error)] : []));
    const table = !isRunning && view.why ? whyTable({ run, base, why: view.why, key }) : null;
    tableHost.replaceChildren(...(table ? [h('p', { class: 'oc-label' }, whyTableLabel(question, base[key])), table] : []));
    tableHost.hidden = !table;
    actions.hidden = isRunning;
    if (!isRunning && document.activeElement === stop) again.focus();
  }

  function ask() {
    detail.replaceChildren();
    void runner.start();
  }

  if (fits(entry.why, run)) {
    view = { phase: entry.why.done < entry.why.words ? 'stopped' : 'done', at: null, why: entry.why, error: null };
    draw();
  } else {
    ask();
  }

  return {
    el,
    close() {
      if (closed) return;
      closed = true;
      runner.stop();
      off();
    },
  };
}
