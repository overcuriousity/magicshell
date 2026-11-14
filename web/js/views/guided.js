// The guided view: two or three small steps in plain words, then the answer as a tinted verdict and bars
// with percentages. No sentence about the answer, no types, tokens, model names or latency.
// Typing edits the model quietly; other changes rebuild the step, and focus finds its way back by
// data-fid (or to the heading when the step changed).
import { LIMITS } from '../limits.js';
import { HREF } from '../routes.js';
import { SCALES } from '../setups-builtin.js';
import { levelClass, optionClass } from '../ui/colors.js';
import { completing } from '../ui/complete.js';
import { h, present } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { picker } from '../ui/menu.js';
import { inlineError } from '../ui/notice.js';
import { answerResult, guidedVerdict } from '../ui/results.js';
import { createGuidedModel, takeGuidedRun } from './guided-model.js';
import { createWhyPanel, whyButton } from './why-panel.js';

const SPINNER_AFTER_MS = 400;

const ASK_KINDS = [
  { id: 'noul', label: 'a yes-or-no question', hint: 'The model answers yes or no' },
  { id: 'choice', label: 'a choice between options', hint: 'You name the options, it picks one' },
  { id: 'score', label: 'for a rating', hint: 'A rating on a scale' },
  { id: 'other', label: 'something else', hint: 'Opens the bench' },
];
const CONTEXT_LABEL = 'Additional context (optional)';
const LEADS = { 1: 'I want to ask', 2: 'What is your question?', choice: 'Which options can it pick from?', score: 'On which scale?' };

const uid = () => crypto.randomUUID();

export function createGuidedView() {
  let model = null;
  let root = null;
  let ctx = null;
  let suggest = null;
  let off = null;
  let quiet = false;
  let spinner = false;
  let spinnerTimer = null;
  let lastBusy = false;
  let lastStep = null;
  let shownError = null;
  let refused = false;
  let lastWhyOpen = false;
  let panel = null;
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
  // Step 1 names no total: how many steps follow depends on the kind chosen there.
  const stepLine = (n) => h('p', { class: 'ms-guide__step' }, n === 1 ? 'Step 1' : `Step ${n} of ${model.lastStep()}`);
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

  function contextField(state) {
    const area = h('textarea', {
      class: 'oc-input',
      id: 'guide-context',
      rows: '3',
      maxlength: String(LIMITS.state),
      'data-fid': 'context',
      oninput: typing((e) => model.setContext(e.target.value)),
    }, state.context);
    return h('div', { class: 'oc-field' }, h('label', { for: 'guide-context' }, CONTEXT_LABEL),
      completing(area, { suggest, pool: 'situation', limit: LIMITS.state, row: { label: 'Recent:', items: (s) => s.recent('situation') } }));
  }

  // One button per kind, two by two: choosing one goes on to the question; "something else"
  // opens the bench. Coming back to a draft, its kind is marked.
  function choose(id) {
    if (model.state.busy) return;
    if (id === 'other') {
      ctx.toBench();
      return;
    }
    model.setKind(id);
    model.next();
  }

  function kindStep(state) {
    return [
      stepLine(1),
      heading(LEADS[1]),
      h('div', { class: 'ms-kinds', role: 'group', 'aria-labelledby': 'guide-lead' },
        ASK_KINDS.map((k) => h('button', {
          type: 'button',
          class: 'oc-btn ms-kind',
          'data-fid': `kind-${k.id}`,
          'aria-current': k.id === state.kind && model.holdsSomething() ? 'true' : null,
          'aria-describedby': `kind-${k.id}-hint`,
          onclick: () => choose(k.id),
        },
          icon(`kind-${k.id}`, 'tab'),
          h('span', { class: 'ms-kind__label' }, k.label),
          h('span', { class: 'ms-kind__hint', id: `kind-${k.id}-hint` }, k.hint)))),
    ];
  }

  // The question is one line, to say that it is short; what the model should know goes in the
  // context below it, which step 3 shows again with what was typed here. A yes-or-no question
  // has no step 3 and is asked from here.
  function questionStep(state) {
    return [
      stepLine(2),
      heading(LEADS[2]),
      completing(h('input', {
        type: 'text',
        class: 'oc-input',
        value: state.question,
        autocomplete: 'off',
        maxlength: String(LIMITS.questionText),
        'data-fid': 'question',
        'aria-labelledby': 'guide-lead',
        oninput: typing((e) => model.setQuestion(e.target.value)),
        onkeydown: (e) => {
          if (e.key !== 'Enter' || e.isComposing) return;
          e.preventDefault();
          model.next();
        },
      }), { suggest, pool: 'question', limit: LIMITS.questionText, row: { label: 'Recent:', items: (s) => s.recent('question') } }),
      contextField(state),
    ];
  }

  function optionsPart(state) {
    const input = h('input', { type: 'text', class: 'oc-input', id: 'guide-option-new', 'data-fid': 'option-new', autocomplete: 'off', maxlength: String(LIMITS.optionName) });
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
      full ? null : h('div', { class: 'oc-field' },
        h('label', { for: 'guide-option-new' }, 'New option'),
        h('div', { class: 'oc-row ms-guide__add' }, completing(input, {
          suggest,
          pool: 'option',
          limit: LIMITS.optionName,
          row: {
            label: 'Often used:',
            items: (s) => s.frequent('option', 5, model.state.options.map((o) => o.name)),
            onPick: (t) => {
              model.addOption(t);
              root.querySelector('[data-fid="option-new"]')?.focus({ preventScroll: true });
            },
          },
        }), h('button', { type: 'button', class: 'oc-btn', 'data-fid': 'option-add', onclick: add }, icon('plus'), 'Add'))),
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
      h('p', { class: 'oc-field__label ms-guide__levels-lead', 'aria-hidden': 'true' }, 'Levels, lowest first'),
      h('ol', { class: 'ms-guide__levels', 'aria-label': 'Levels, lowest first' },
        levels.map((l, i) =>
          h('li', { class: 'oc-row' },
            h('span', { class: `ms-dot ${levelClass(i, levels.length)}`, 'aria-hidden': 'true' }),
            completing(
              h('input', { type: 'text', class: 'oc-input', value: l.text, 'aria-label': `Level ${i + 1}`, 'data-fid': `level:${l.id}`, autocomplete: 'off', maxlength: String(LIMITS.level), oninput: typing((e) => setText(l.id, e.target.value)) }),
              { suggest, pool: 'level', limit: LIMITS.level }),
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
    body.push(...(state.kind === 'choice' ? optionsPart(state) : scalePart(state)));
    body.push(contextField(state));
    return body;
  }

  // The panel is made once per opening and kept across re-renders; it is closed whenever it goes away.
  function closePanel() {
    panel?.close();
    panel = null;
  }

  function resultStep(state) {
    const { question, answer, entry } = state.result;
    const asked = h('h1', { class: 'ms-guide__asked', tabindex: '-1' }, question.text);
    if (state.whyOpen && entry) {
      panel ??= createWhyPanel({
        client: ctx.client,
        entry,
        save: (why) => model.saveWhy(entry, why),
        onBack: model.closeWhy,
        onAuth: () => ctx.navigate(HREF.signIn),
      });
      return [asked, panel.el];
    }
    closePanel();
    return [
      asked,
      guidedVerdict(question, answer),
      answerResult(question, answer, { percent: true, pick: false }),
      whyButton({ entry, why: ctx.why, onOpen: model.openWhy }),
    ];
  }

  function actions(state) {
    if (state.step === 'result') {
      return [button('Start over', () => model.startOver(), { fid: 'start-over' }), button('Ask another', () => model.askAnother(), { primary: true, fid: 'ask-another' })];
    }
    // Step 1 has no Next: each kind button goes on by itself.
    if (state.step === 1) return [];
    const back = button('Back', () => model.back(), { fid: 'back', disabled: state.busy });
    if (state.step === model.lastStep()) return [back, button('Ask', () => model.ask(), { primary: true, fid: 'ask', busy: state.busy })];
    return [back, button('Next', () => model.next(), { primary: true, fid: 'next' })];
  }

  function renderBody(state) {
    const steps = { 1: kindStep, 2: questionStep, 3: detailsStep, result: resultStep };
    hosts.body.replaceChildren(...present(steps[state.step](state)));
  }

  function renderActions(state) {
    hosts.actions.replaceChildren(...present(actions(state)));
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
    // The heading is rebuilt with the body (the history save lands after the result shows), so
    // focus on it has to follow to the new one.
    const headingFocused = document.activeElement === root.querySelector('h1');
    if (stepChanged) {
      rebuild = true;
    }
    if (state.step !== 'result') closePanel();
    if (!quiet || rebuild) {
      renderBody(state);
      renderActions(state);
    } else if (ended) {
      renderActions(state);
    }
    renderError(state, ended);
    const first = lastStep === null;
    lastStep = state.step;
    const whyChanged = state.whyOpen !== lastWhyOpen;
    lastWhyOpen = state.whyOpen;
    if (whyChanged && !stepChanged) {
      root.querySelector('h1')?.focus({ preventScroll: true });
    } else if (stepChanged && !first) {
      window.scrollTo(0, 0);
      root.querySelector('h1')?.focus({ preventScroll: true });
    } else if (fid && !root.contains(document.activeElement)) {
      refocus(fid);
    } else if (headingFocused && !root.contains(document.activeElement)) {
      root.querySelector('h1')?.focus({ preventScroll: true });
    }
  }

  const onKey = (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !model) return;
    e.preventDefault();
    if (model.state.step === 1) choose(model.state.kind);
    else if (model.state.step !== 'result') model.next();
  };

  return {
    mount(el, context) {
      root = el;
      ctx = context;
      suggest = ctx.store?.suggest;
      suggest?.load();
      spinner = false;
      lastBusy = false;
      lastStep = null;
      lastWhyOpen = false;
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
      closePanel();
      root?.removeEventListener('keydown', onKey);
      root = null;
      model = null;
    },
  };
}
