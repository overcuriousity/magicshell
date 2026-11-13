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

// What an option means to the model; empty, its name stands in.
const DESCRIPTION = 'Description (optional)';

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
// With `id` a <label for> names it and `label` is left out.
function textInput(value, label, fid, onText, { mono = false, readonly = false, id = null } = {}) {
  return h('input', {
    type: 'text',
    class: mono ? 'oc-input ms-mono' : 'oc-input',
    id,
    value,
    'aria-label': id ? null : label,
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
        // The lead shows only where the rows stack and the head above the columns is gone.
        h('div', { class: 'ms-row__desc' },
          h('span', { class: 'ms-row__desc-lead', 'aria-hidden': 'true' }, DESCRIPTION),
          textInput(item.description, `Description ${i + 1} (optional)`, `${f}:desc`, (v) => edit({ description: v }))),
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
    ? [h('span', { class: 'ms-row__name' }, 'Options'), h('span', { class: 'ms-row__desc' }, DESCRIPTION)]
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

// fq: the card's focus prefix by position, so focus finds its way back after a rebuild; ids take
// the editor's prefix as well, so A's and B's cards never share one.
function card(q, index, count, ops, locked, slots, { idPrefix, fidPrefix }) {
  // The key is renamed on change, not per keystroke; every handler reads the key the card holds now.
  const ref = { key: q.key };
  const fq = `${fidPrefix}q${index}`;
  const textId = `${idPrefix}-${fq}-text`;
  const keyId = `${idPrefix}-${fq}-key`;
  const commitKey = (input) => {
    const next = input.value.trim();
    if (next === ref.key) input.value = ref.key;
    else if (ops.renameQuestion(ref.key, next)) ref.key = next;
    else input.value = ref.key;
  };
  const keyInput = h('input', {
    type: 'text',
    class: 'oc-input ms-mono ms-card__key',
    id: keyId,
    value: q.key,
    'data-fid': `${fq}:key`,
    autocomplete: 'off',
    spellcheck: 'false',
    readonly: locked,
    onchange: (e) => commitKey(e.target),
    // Ctrl+Enter runs from the view's listener above this one: commit the pending key first, so the
    // run does not go out with the old one (change fires only on blur).
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitKey(e.target);
    },
  });
  return h('div', { class: 'ms-card' },
    h('div', { class: 'ms-card__head' },
      // The picker names itself ("Type"); the lead above it is for the eye.
      h('div', { class: 'oc-field ms-card__type' },
        h('span', { class: 'oc-field__label', 'aria-hidden': 'true' }, 'Type'),
        locked ? h('span', { class: 'ms-type' }, q.type) : typePicker(q, ref, ops, `${fq}:type`)),
      h('div', { class: 'oc-field ms-card__keyfield' }, h('label', { for: keyId }, 'Key'), keyInput),
      locked ? null : iconButton('trash', 'Remove question', () => ops.removeQuestion(ref.key), { disabled: count <= 1, fid: `${fq}:drop` }),
    ),
    h('div', { class: 'oc-field' },
      h('label', { for: textId }, 'Question'),
      textInput(q.text, 'Question', `${fq}:text`, (v) => ops.updateText(ref.key, v), { id: textId }),
    ),
    q.type === 'choice' ? list('option', q, ref, ops, fq, slots) : null,
    q.type === 'score' ? list('level', q, ref, ops, fq, slots) : null,
  );
}

// slotsFor(q): colour positions for q's rows (B's editor takes them from A), or null for position.
// idPrefix and fidPrefix: unique per editor on the page, so A's and B's cards share no id and focus
// returns to the editor it was in.
export function questionCards(run, ops, { locked = false, slotsFor = () => null, idPrefix = 'bench', fidPrefix = '' } = {}) {
  return run.questions.map((q, i) => card(q, i, run.questions.length, ops, locked, slotsFor(q), { idPrefix, fidPrefix }));
}
