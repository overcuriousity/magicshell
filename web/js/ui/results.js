// Drawing of answers: names, numbers and bars, never a sentence. Every function returns an Element.
// Numbers are probabilities (two decimals) or, with { percent: true }, whole percents.
// Bars are one grid, a row per option or level (label, bar, number); opts.deltas adds a fourth
// column (.ms-bars--delta) with the change beside each number; opts.colors gives the rows
// the colour slots of another order (a variant keeps each option's and level's colour from A).
import { nearestLevel, noulIsYes, pct, prob, scoreText, signed } from '../format.js';
import { levelClass, optionClass } from './colors.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const num = (p, opts) => (opts?.percent ? pct(p) : prob(p));
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const width = (p) => `${(clamp01(p) * 100).toFixed(1)}%`;

function setWidth(el, p) {
  el.style.setProperty('--w', width(p));
  return el;
}

function pickLine(name, confidence, opts) {
  return h(
    'div',
    { class: 'ms-pick' },
    h('span', { class: 'ms-pick__name' }, name),
    h('span', { class: 'ms-pick__meta' }, `confidence ${num(confidence, opts)}`),
  );
}

// One bar row: label, plain bar (an image with name and number), number, and with opts.deltas
// the change beside it (a number, or null for none). `cls` carries the colour.
function barRow(label, p, cls, opts, i) {
  const text = num(p, opts);
  const delta = opts?.deltas ? opts.deltas[i] : undefined;
  const change = typeof delta === 'number' ? signed(delta) : '';
  return h(
    'div',
    { class: 'ms-bar' },
    h('span', { class: 'ms-bar__label', 'aria-hidden': 'true' }, label),
    setWidth(h('span', { class: `ms-bar__fill ${cls}`, role: 'img', 'aria-label': change ? `${label} ${text} ${change}` : `${label} ${text}` }), p),
    h('span', { class: 'ms-bar__num', 'aria-hidden': 'true' }, text),
    opts?.deltas ? h('span', { class: 'ms-bar__delta', 'aria-hidden': 'true' }, change) : null,
  );
}

const barsClass = (opts) => (opts?.deltas ? 'ms-bars ms-bars--delta' : 'ms-bars');

const optionNames = (question) => question.options.map((o) => o.name.trim());
const levelTexts = (question) => question.levels.map((l) => l.text.trim());

export function choiceResult(question, answer, opts = {}) {
  const names = optionNames(question);
  return h(
    'div',
    { class: 'ms-answer' },
    pickLine(answer.choice, answer.confidence, opts),
    h('div', { class: barsClass(opts) }, names.map((name, i) => barRow(name, answer.probabilities[i], optionClass(opts.colors?.[i] ?? i), opts, i))),
  );
}

export function scoreResult(question, answer, opts = {}) {
  const texts = levelTexts(question);
  const count = texts.length;
  const nearest = nearestLevel(answer.score, count);
  const at = clamp01((answer.score + 0.5) / count);
  const mark = h('div', { class: 'ms-mark', 'aria-hidden': 'true' });
  mark.style.setProperty('--at', width(at));
  return h(
    'div',
    { class: 'ms-answer' },
    pickLine(`${scoreText(answer.score)} · ${texts[nearest]}`, answer.confidence, opts),
    mark,
    h('div', { class: 'ms-scale', 'aria-hidden': 'true' }, texts.map((_, i) => h('span', { class: levelClass(opts.colors?.[i] ?? i, count) }))),
    h('div', { class: 'ms-ends' }, h('span', null, texts[0]), h('span', null, texts[count - 1])),
    h('div', { class: barsClass(opts) }, texts.map((text, i) => barRow(text, answer.probabilities[i], levelClass(opts.colors?.[i] ?? i, count), opts, i))),
  );
}

export function noulResult(_question, answer, opts = {}) {
  const yes = noulIsYes(answer.noul);
  const label = `Yes ${num(answer.noul, opts)}`;
  const fill = setWidth(h('span', { class: 'ms-meter__fill' }), answer.noul);
  return h(
    'div',
    { class: 'ms-answer' },
    h(
      'div',
      { class: 'ms-pick' },
      h('span', { class: 'ms-pick__name' }, yes ? 'Yes' : 'No'),
      h('span', { class: 'ms-pick__meta' }, `${num(answer.noul, opts)} yes`),
    ),
    h('div', { class: 'ms-meter', role: 'img', 'aria-label': label }, fill, h('span', { class: 'ms-meter__half' })),
  );
}

// The tinted block of the guided view: the pick, Yes or No, or the score with its level text.
export function guidedVerdict(question, answer) {
  let text;
  let cls;
  if (answer.type === 'choice') {
    text = answer.choice;
    cls = optionClass(Math.max(0, optionNames(question).indexOf(answer.choice)));
  } else if (answer.type === 'score') {
    const texts = levelTexts(question);
    const nearest = nearestLevel(answer.score, texts.length);
    text = `${scoreText(answer.score)} · ${texts[nearest]}`;
    cls = levelClass(nearest, texts.length);
  } else {
    text = noulIsYes(answer.noul) ? 'Yes' : 'No';
    cls = 'ms-accent';
  }
  return h('div', { class: `ms-verdict ${cls}` }, h('span', null, text), icon('check'));
}

// The block for one answer by its type.
export function answerResult(question, answer, opts) {
  if (answer.type === 'choice') return choiceResult(question, answer, opts);
  if (answer.type === 'score') return scoreResult(question, answer, opts);
  return noulResult(question, answer, opts);
}
