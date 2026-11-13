// Why?: the situation with every word marked by what leaving it out did to one question, the
// legend for the marks, and the table of the strongest words. Marks are a shade in the direction's
// colour plus a step class; the numbers are in each word's aria-label and tooltip, never colour alone.
import { changeText, describe, flipName, legend, measured, measuredName, pickOf, splitWords, strongest, valueText, wordInfo } from '../why.js';
import { h } from './dom.js';

const questionOf = (run, key) => run.questions.find((q) => q.key === key);

const ROVE = {
  ArrowRight: (i) => i + 1,
  ArrowLeft: (i) => i - 1,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

// Exactly one word button in the tab order; arrows, Home and End move between them.
export function rove(buttons, active) {
  buttons.forEach((b, i) => b.setAttribute('tabindex', i === active ? '0' : '-1'));
}

function wordElement(word, question, info, out) {
  if (out) return h('span', { class: 'ms-why__w ms-why__w--out' }, word);
  if (!info || (!info.effect && info.flip === undefined)) return h('span', { class: 'ms-why__w' }, word);
  const label = `${word}, ${describe(question, info)}`;
  const cls = ['ms-why__w'];
  if (info.effect) cls.push(`ms-why--${info.dir}`, `ms-why--s${info.step}`);
  if (info.flip !== undefined) cls.push('ms-why__w--flip');
  return h('button', { type: 'button', class: cls.join(' '), 'data-oc-tip': label, 'aria-label': label }, word);
}

// onWord(text) is called with describe(…) when a word button is activated (click, tap, Enter).
export function whyText({ run, base, why, key, at = null, onWord = () => {} }) {
  const { state } = run;
  const question = questionOf(run, key);
  const words = splitWords(state);
  const el = h('div', { class: 'ms-why__text' });
  const buttons = [];
  let pos = 0;
  words.forEach((w, i) => {
    if (w.start > pos) el.append(state.slice(pos, w.start));
    const info = why ? wordInfo(why, run, base, key, i) : null;
    const node = wordElement(state.slice(w.start, w.end), question, info, i === at);
    if (node.tagName.toLowerCase() === 'button') {
      const index = buttons.length;
      node.setAttribute('data-i', String(i));
      node.addEventListener('click', () => {
        rove(buttons, index);
        onWord(describe(question, info));
      });
      node.addEventListener('keydown', (e) => {
        const move = ROVE[e.key];
        if (!move) return;
        e.preventDefault();
        const next = Math.min(Math.max(move(index, buttons.length), 0), buttons.length - 1);
        rove(buttons, next);
        buttons[next].focus();
      });
      buttons.push(node);
    }
    el.append(node);
    pos = w.end;
  });
  if (pos < state.length) el.append(state.slice(pos));
  rove(buttons, 0);
  return el;
}

const FLIP_ITEM = {
  choice: 'without it the pick changes',
  score: 'without it the nearest level changes',
  noul: 'without it the answer changes',
};

export function whyLegend(question, answer) {
  const names = legend(question, answer);
  const swatch = (dir) => h('span', { class: `ms-why__sw ms-why--${dir} ms-why--s5`, 'aria-hidden': 'true' });
  return h(
    'div',
    { class: 'ms-why__legend' },
    h('span', {}, swatch('towards'), names.towards),
    h('span', {}, swatch('away'), names.away),
    h('span', {}, h('span', { class: 'ms-why__flipmark', 'aria-hidden': 'true' }, '⇄'), FLIP_ITEM[question.type]),
  );
}

// The label over the table, e.g. "Strongest words · sushi was 47 %".
export function whyTableLabel(question, answer) {
  const name = measuredName(question, pickOf(question, answer));
  return `Strongest words · ${name} was ${valueText(question, measured(question, answer))}`;
}

// A word as listed in the table: its leading and trailing punctuation dropped, unless that is all it is.
const bare = (word) => word.replace(/^\p{P}+|\p{P}+$/gu, '') || word;

export function whyTable({ run, base, why, key }) {
  const question = questionOf(run, key);
  const rows = strongest(why, run, base, key);
  if (rows.length === 0) return null;
  const words = splitWords(run.state);
  return h(
    'table',
    { class: 'ms-why__table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Word'), h('th', { scope: 'col' }, 'With → without'), h('th', { scope: 'col' }, 'Change'))),
    h(
      'tbody',
      {},
      rows.map((r) => {
        const w = words[r.index];
        const flip = r.flip === undefined ? null : h('span', { class: 'ms-why__flip' }, `⇄ ${flipName(question, r.flip)}`);
        return h(
          'tr',
          {},
          h('td', {}, bare(run.state.slice(w.start, w.end)), flip ? ' ' : null, flip),
          h('td', { class: 'ms-why__num' }, `${valueText(question, r.before)} → ${valueText(question, r.after)}`),
          h('td', { class: 'ms-why__num' }, changeText(question, r.delta)),
        );
      }),
    ),
  );
}
