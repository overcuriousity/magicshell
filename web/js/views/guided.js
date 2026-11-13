// The guided view: three small steps in plain words, then the answer as a tinted verdict and bars
// with percentages. No sentence about the answer, no types, tokens, model names or latency.
// Typing edits the model quietly; other changes rebuild the step, and focus finds its way back by
// data-fid (or to the heading when the step changed).
import { LIMITS } from '../limits.js';
import { SCALES } from '../setups-builtin.js';
import { levelClass, optionClass } from '../ui/colors.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { picker } from '../ui/menu.js';
import { inlineError } from '../ui/notice.js';
import { answerResult, guidedVerdict } from '../ui/results.js';
import { createGuidedModel, takeGuidedRun } from './guided-model.js';

const SPINNER_AFTER_MS = 400;

const ASK_KINDS = [
  { id: 'noul', label: 'a yes-or-no question', hint: 'The model answers yes or no' },
  { id: 'choice', label: 'a choice between options', hint: 'You name the options, it picks one' },
  { id: 'score', label: 'for a rating', hint: 'A rating on a scale' },
  { id: 'other', label: 'something else', hint: 'Opens the bench' },
];
const CONTEXT_LABEL = 'Anything it should know? (optional)';
const LEADS = { 1: 'I want to ask', 2: 'What is your question?', choice: 'Which options can it pick from?', score: 'On which scale?', noul: CONTEXT_LABEL };

const uid = () => crypto.randomUUID();

export function createGuidedView() {
  let model = null;
  let root = null;
  let ctx = null;
  let off = null;
  let quiet = false;
  let other = false;
  let spinner = false;
  let spinnerTimer = null;
  let lastBusy = false;
  let lastStep = null;
  let shownError = null;
  let refused = false;
  const hosts = {};

  const typing = (fn) => (...args) => {
    quiet = true;
    try {
      fn(...args);
    } finally {
      quiet = false;
    }
  };

  const heading = (text) => h('h1', { class: 'oc-text-page ms-guide__lead', id: 'guide-lead', tabindex: '-1' }, text);
  const stepLine = (n) => h('p', { class: 'ms-guide__step' }, `Step ${n} of 3`);
  // busy: aria-disabled with the spinner after a moment; disabled: aria-disabled only (the model ignores it).
  const button = (label, onclick, { primary = false, fid, busy = false, disabled = false } = {}) =>
    h('button', {
      type: 'button',
      class: primary ? 'oc-btn oc-btn--primary' : 'oc-btn',
      'data-fid': fid,
      'aria-busy': busy && spinner ? 'true' : null,
      'aria-disabled': busy || disabled ? 'true' : null,
      onclick,
    }, label);

  function contextField(state, labelled) {
    const area = h('textarea', {
      class: 'oc-input',
      id: 'guide-context',
      rows: '3',
      maxlength: String(LIMITS.state),
      'data-fid': 'context',
      'aria-labelledby': labelled ? 'guide-lead' : null,
      oninput: typing((e) => model.setContext(e.target.value)),
    }, state.context);
    return labelled ? area : h('div', { class: 'oc-field' }, h('label', { for: 'guide-context' }, CONTEXT_LABEL), area);
  }

  function kindStep(state) {
    const current = other ? 'other' : state.kind;
    const select = h('select', {
      'aria-label': LEADS[1],
      onchange: (e) => {
        other = e.target.value === 'other';
        if (other) render(model.state, { rebuild: true });
        else model.setKind(e.target.value);
      },
    }, ASK_KINDS.map((k) => h('option', { value: k.id, selected: k.id === current, 'data-hint': k.hint }, k.label)));
    const control = picker(select);
    (control.querySelector?.('button') ?? control).setAttribute('data-fid', 'kind');
    return [
      stepLine(1),
      heading(LEADS[1]),
      h('div', { class: 'ms-guide__kind' }, control),
      h('p', { class: 'ms-guide__hint' }, ASK_KINDS.find((k) => k.id === current).hint),
    ];
  }

  function questionStep(state) {
    return [
      stepLine(2),
      heading(LEADS[2]),
      h('textarea', {
        class: 'oc-input',
        rows: '3',
        maxlength: String(LIMITS.questionText),
        'data-fid': 'question',
        'aria-labelledby': 'guide-lead',
        oninput: typing((e) => model.setQuestion(e.target.value)),
      }, state.question),
    ];
  }

  function optionsPart(state) {
    const input = h('input', { type: 'text', class: 'oc-input', 'aria-label': 'New option', 'data-fid': 'option-new', autocomplete: 'off', maxlength: String(LIMITS.optionName) });
    const add = () => {
      model.addOption(input.value);
      root.querySelector('[data-fid="option-new"]')?.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        add();
      }
    });
    const full = state.options.length >= LIMITS.maxOptions;
    return [
      h('ul', { class: 'ms-chips ms-guide__chips', 'aria-label': 'Options' },
        state.options.map((o, i) =>
          h('li', { class: `ms-chip ${optionClass(i)}` },
            h('span', { class: 'ms-dot', 'aria-hidden': 'true' }),
            h('span', {}, o.name),
            h('button', {
              type: 'button',
              class: 'ms-chip__remove',
              'aria-label': `Remove ${o.name}`,
              'data-oc-tip': 'Remove',
              'data-fid': `option:${o.id}`,
              onclick: () => {
                model.removeOption(o.id);
                root.querySelector('[data-fid="option-new"]')?.focus({ preventScroll: true });
              },
            }, icon('x', 'row')),
          ),
        ),
      ),
      full ? null : h('div', { class: 'oc-row ms-guide__add' }, input, h('button', { type: 'button', class: 'oc-btn', 'data-fid': 'option-add', onclick: add }, icon('plus'), 'Add')),
    ];
  }

  function scalePart(state) {
    const select = h('select', { 'aria-label': LEADS.score, onchange: (e) => model.setScale(e.target.value) },
      SCALES.map((s) => h('option', { value: s.id, selected: s.id === state.scaleId }, s.name)),
      h('option', { value: 'own', selected: state.scaleId === 'own' }, 'My own'));
    const control = picker(select);
    (control.querySelector?.('button') ?? control).setAttribute('data-fid', 'scale');
    const parts = [h('div', { class: 'ms-guide__kind' }, control)];
    if (state.scaleId !== 'own') {
      const texts = SCALES.find((s) => s.id === state.scaleId).levels;
      parts.push(h('ul', { class: 'ms-chips ms-guide__chips', 'aria-label': 'Levels' },
        texts.map((t, i) => h('li', { class: `ms-chip ${levelClass(i, texts.length)}` }, h('span', { class: 'ms-dot', 'aria-hidden': 'true' }), h('span', {}, t)))));
      return parts;
    }
    const levels = state.levels;
    const setText = (id, text) => model.setLevels(model.state.levels.map((l) => (l.id === id ? { ...l, text } : l)));
    parts.push(
      h('ol', { class: 'ms-guide__levels', 'aria-label': 'Levels, lowest first' },
        levels.map((l, i) =>
          h('li', { class: 'oc-row' },
            h('span', { class: `ms-dot ${levelClass(i, levels.length)}`, 'aria-hidden': 'true' }),
            h('input', { type: 'text', class: 'oc-input', value: l.text, 'aria-label': `Level ${i + 1}`, 'data-fid': `level:${l.id}`, autocomplete: 'off', maxlength: String(LIMITS.level), oninput: typing((e) => setText(l.id, e.target.value)) }),
            h('button', {
              type: 'button',
              class: 'oc-btn oc-btn--icon oc-btn--row',
              'aria-label': 'Remove level',
              'data-oc-tip': 'Remove level',
              'data-fid': `level-remove:${l.id}`,
              disabled: levels.length <= LIMITS.minLevels,
              onclick: () => model.setLevels(model.state.levels.filter((x) => x.id !== l.id)),
            }, icon('x', 'row')),
          ),
        ),
      ),
      h('div', { class: 'oc-row' },
        h('button', {
          type: 'button',
          class: 'oc-btn',
          'data-fid': 'level-add',
          disabled: levels.length >= LIMITS.maxLevels,
          onclick: () => model.setLevels([...model.state.levels, { id: uid(), text: '' }]),
        }, icon('plus'), 'Add level'),
      ),
    );
    return parts;
  }

  function detailsStep(state) {
    const body = [stepLine(3), heading(LEADS[state.kind])];
    if (state.kind === 'choice') body.push(...optionsPart(state));
    if (state.kind === 'score') body.push(...scalePart(state));
    body.push(contextField(state, state.kind === 'noul'));
    return body;
  }

  function resultStep(state) {
    const { question, answer } = state.result;
    return [
      h('h1', { class: 'ms-guide__asked', tabindex: '-1' }, question.text),
      guidedVerdict(question, answer),
      answerResult(question, answer, { percent: true, pick: false }),
    ];
  }

  function actions(state) {
    if (state.step === 'result') {
      return [button('Start over', () => model.startOver(), { fid: 'start-over' }), button('Ask another', () => model.askAnother(), { primary: true, fid: 'ask-another' })];
    }
    const back = state.step === 1 ? null : button('Back', () => model.back(), { fid: 'back', disabled: state.busy });
    if (state.step === 3) return [back, button('Ask', () => model.ask(), { primary: true, fid: 'ask', busy: state.busy })];
    const next = () => {
      if (state.step === 1 && other) ctx.toBench();
      else model.next();
    };
    return [back, button('Next', next, { primary: true, fid: 'next' })];
  }

  function renderBody(state) {
    const steps = { 1: kindStep, 2: questionStep, 3: detailsStep, result: resultStep };
    hosts.body.replaceChildren(...steps[state.step](state));
  }

  function renderActions(state) {
    hosts.actions.replaceChildren(...actions(state).filter(Boolean));
  }

  function renderError(state, force) {
    const text = state.error;
    if (text === shownError && !force) return;
    shownError = text;
    hosts.error.replaceChildren(...(text ? [inlineError(text)] : []));
  }

  function trackBusy(state) {
    if (state.busy === lastBusy) return false;
    const ended = lastBusy && !state.busy;
    lastBusy = state.busy;
    clearTimeout(spinnerTimer);
    spinner = false;
    if (state.busy) {
      spinnerTimer = setTimeout(() => {
        spinner = true;
        root?.querySelector('[data-fid="ask"]')?.setAttribute('aria-busy', 'true');
      }, SPINNER_AFTER_MS);
    }
    return ended;
  }

  function refocus(fid) {
    for (const f of [fid, fid?.startsWith('option') ? 'option-new' : null, fid?.startsWith('level') ? 'level-add' : null]) {
      if (!f) continue;
      const el = root.querySelector(`[data-fid="${f}"]`);
      if (el && !el.disabled) {
        el.focus({ preventScroll: true });
        return;
      }
    }
    root.querySelector('h1')?.focus({ preventScroll: true });
  }

  function render(state, { rebuild = false } = {}) {
    const stepChanged = state.step !== lastStep;
    const ended = trackBusy(state);
    const fid = root.contains(document.activeElement) ? document.activeElement.getAttribute('data-fid') : null;
    if (stepChanged) {
      if (state.step !== 1) other = false;
      rebuild = true;
    }
    if (!quiet || rebuild) {
      renderBody(state);
      renderActions(state);
    } else if (ended) {
      renderActions(state);
    }
    renderError(state, ended);
    const first = lastStep === null;
    lastStep = state.step;
    if (stepChanged && !first) {
      window.scrollTo(0, 0);
      root.querySelector('h1')?.focus({ preventScroll: true });
    } else if (fid && !root.contains(document.activeElement)) {
      refocus(fid);
    }
  }

  const onKey = (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !model) return;
    e.preventDefault();
    if (model.state.step === 3) model.ask();
    else if (model.state.step === 1 || model.state.step === 2) root.querySelector('[data-fid="next"]')?.click();
  };

  return {
    mount(el, context) {
      root = el;
      ctx = context;
      other = false;
      spinner = false;
      lastBusy = false;
      lastStep = null;
      shownError = null;
      root.classList.add('ms-guide');
      model = createGuidedModel({ client: ctx.client, store: ctx.store, mode: ctx.mode, navigate: ctx.navigate });
      // A run handed over (by the bench or History): one question lands at step 2; any other
      // run cannot be asked here, and the guide keeps its own draft.
      // `refused` until the next edit: switching straight back then hands nothing to the bench,
      // so a round trip leaves both drafts as they were.
      const handed = takeGuidedRun();
      refused = Boolean(handed) && !model.load(handed);
      hosts.body = h('div', { class: 'ms-guide__body' });
      hosts.error = h('div', { class: 'ms-error-host' });
      hosts.actions = h('div', { class: 'oc-row ms-guide__actions' });
      root.append(h('section', { class: 'ms-guide__panel', 'aria-label': 'Ask' }, hosts.body, hosts.error, hosts.actions));
      root.addEventListener('keydown', onKey);
      off = model.subscribe((s) => {
        refused = false;
        render(s);
      });
      render(model.state);
    },
    // The setup as entered, for the bench when the user switches over; null when nothing was, or
    // when the bench's run was refused and nothing changed since.
    currentRun: () => (model && !refused && model.holdsSomething() ? model.toRun() : null),
    unmount() {
      off?.();
      clearTimeout(spinnerTimer);
      root?.removeEventListener('keydown', onKey);
      root = null;
      model = null;
    },
  };
}
