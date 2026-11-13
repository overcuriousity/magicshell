// The bench's question cards: type, key, question text, and options or levels with move and remove.
// `ops` edits one run (A through the model, B through editVariant); `locked` keeps type, key and the
// set of questions fixed, as B must keep them to be compared with A.
import { LIMITS } from '../limits.js';
import { optionClass } from '../ui/colors.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { picker } from '../ui/menu.js';

const TYPES = [
  { id: 'choice', label: 'choice' },
  { id: 'score', label: 'score' },
  { id: 'noul', label: 'noul' },
];

const iconButton = (name, label, onclick, { disabled = false, fid } = {}) =>
  h('button', {
    type: 'button',
    class: 'oc-btn oc-btn--icon oc-btn--row',
    'aria-label': label,
    'data-oc-tip': label,
    'data-fid': fid,
    disabled,
    onclick,
  }, icon(name, 'row'));

// A text input bound to one field; typing edits quietly (no rebuild), so focus and caret stay.
function textInput(value, label, fid, onText, { mono = false, readonly = false } = {}) {
  return h('input', {
    type: 'text',
    class: mono ? 'oc-input ms-mono' : 'oc-input',
    value,
    'aria-label': label,
    'data-fid': fid,
    autocomplete: 'off',
    spellcheck: mono ? 'false' : null,
    readonly,
    oninput: (e) => onText(e.target.value),
  });
}

function typePicker(q, ref, ops, fid) {
  const select = h('select', { 'aria-label': 'Type', onchange: (e) => ops.retype(ref.key, e.target.value) },
    TYPES.map((t) => h('option', { value: t.id, selected: t.id === q.type }, t.label)));
  const control = picker(select);
  (control.querySelector?.('button') ?? control).setAttribute('data-fid', fid);
  return control;
}

const KINDS = {
  option: { many: 'options', min: LIMITS.minOptions, max: LIMITS.maxOptions, add: 'Add option', remove: 'Remove option' },
  level: { many: 'levels', min: LIMITS.minLevels, max: LIMITS.maxLevels, add: 'Add level', remove: 'Remove level' },
};

// One row of a choice or score list: its leading mark, inputs, and move and remove buttons.
function listRow(kind, ref, item, i, count, ops, fq, slot) {
  const { many, min, remove } = KINDS[kind];
  const f = `${fq}:${kind}:${item.id}`;
  const edit = (patch) => ops.updateItem(many, ref.key, item.id, patch);
  const lead = kind === 'option'
    ? h('span', { class: `ms-dot ${optionClass(slot)}`, 'aria-hidden': 'true' })
    : h('span', { class: 'ms-row__index', 'aria-hidden': 'true' }, String(i));
  const fields = kind === 'option'
    ? [
        h('div', { class: 'ms-row__name' }, textInput(item.name, `Option ${i + 1}`, `${f}:name`, (v) => edit({ name: v }))),
        h('div', { class: 'ms-row__desc' }, textInput(item.description, `Description ${i + 1}`, `${f}:desc`, (v) => edit({ description: v }))),
      ]
    : [h('div', { class: 'ms-row__name ms-row__name--wide' }, textInput(item.text, `Level ${i}`, `${f}:text`, (v) => edit({ text: v })))];
  return h('div', { class: kind === 'option' ? 'ms-row' : 'ms-row ms-row--level' },
    h('div', { class: 'ms-row__lead' }, lead),
    fields,
    h('div', { class: 'ms-row__acts' },
      iconButton('chevron-up', 'Move up', () => ops.moveItem(many, ref.key, item.id, -1), { disabled: i === 0, fid: `${f}:up` }),
      iconButton('chevron-down', 'Move down', () => ops.moveItem(many, ref.key, item.id, 1), { disabled: i === count - 1, fid: `${f}:down` }),
      iconButton('x', remove, () => ops.removeItem(many, ref.key, item.id), { disabled: count <= min, fid: `${f}:remove` }),
    ),
  );
}

function list(kind, q, ref, ops, fq, slots) {
  const { many, max, add } = KINDS[kind];
  const items = q[many];
  const head = kind === 'option'
    ? [h('span', { class: 'ms-row__name' }, 'Option'), h('span', { class: 'ms-row__desc' }, 'Description')]
    : [h('span', { class: 'ms-row__name' }, 'Levels, lowest first')];
  return h('div', { class: 'ms-rows' },
    h('div', { class: kind === 'option' ? 'ms-rows__head' : 'ms-rows__head ms-rows__head--level', 'aria-hidden': 'true' }, head),
    items.map((item, i) => listRow(kind, ref, item, i, items.length, ops, fq, slots?.[i] ?? i)),
    h('div', { class: 'ms-rows__foot' },
      h('button', {
        type: 'button',
        class: 'oc-btn',
        'data-fid': `${fq}:add`,
        disabled: items.length >= max,
        onclick: () => ops.addItem(many, ref.key),
      }, icon('plus'), add),
    ),
  );
}

// fq: the card's focus prefix by position, so focus finds its way back after a rebuild.
function card(q, index, count, ops, locked, slots) {
  // The key is renamed on change, not per keystroke; every handler reads the key the card holds now.
  const ref = { key: q.key };
  const fq = `q${index}`;
  const keyInput = h('input', {
    type: 'text',
    class: 'oc-input ms-mono ms-card__key',
    value: q.key,
    'aria-label': 'Key',
    'data-fid': `${fq}:key`,
    autocomplete: 'off',
    spellcheck: 'false',
    readonly: locked,
    onchange: (e) => {
      const next = e.target.value.trim();
      if (ops.renameQuestion(ref.key, next)) ref.key = next;
      else e.target.value = ref.key;
    },
  });
  return h('div', { class: 'ms-card' },
    h('div', { class: 'ms-card__head' },
      locked ? h('span', { class: 'ms-type' }, q.type) : typePicker(q, ref, ops, `${fq}:type`),
      keyInput,
      locked ? null : iconButton('trash', 'Remove question', () => ops.removeQuestion(ref.key), { disabled: count <= 1, fid: `${fq}:drop` }),
    ),
    h('div', { class: 'oc-field' },
      h('span', { class: 'oc-field__label', 'aria-hidden': 'true' }, 'Question'),
      textInput(q.text, 'Question', `${fq}:text`, (v) => ops.updateText(ref.key, v)),
    ),
    q.type === 'choice' ? list('option', q, ref, ops, fq, slots) : null,
    q.type === 'score' ? list('level', q, ref, ops, fq, slots) : null,
  );
}

// slotsFor(q): colour positions for q's rows (B's editor takes them from A), or null for position.
export function questionCards(run, ops, { locked = false, slotsFor = () => null } = {}) {
  return run.questions.map((q, i) => card(q, i, run.questions.length, ops, locked, slotsFor(q)));
}
