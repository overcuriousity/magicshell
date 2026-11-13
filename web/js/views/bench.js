// The bench: the situation and question cards on one side, results on the other (side by side from
// 90rem). Typing edits the model quietly; structural changes rebuild the form and focus finds its way
// back by data-fid. Results always come from the run that produced them (state.ranA / ranB).
import { LIMITS } from '../limits.js';
import { messageOf } from '../run-error.js';
import { BUILTIN } from '../setups-builtin.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { menuButton, picker } from '../ui/menu.js';
import { validateSetup } from '../transfer.js';
import { VARIANTS } from '../variants.js';
import { createBenchModel, takeRun } from './bench-model.js';
import { fromRun } from './setup-model.js';
import { questionCards } from './bench-cards.js';
import { colorSlots, resultsSection, variantLabel } from './bench-results.js';

const SPINNER_AFTER_MS = 400;

// The edits of the question cards, applied to A through the model or to B through editVariant.
function opsForA(model) {
  return {
    retype: (key, type) => model.updateQuestion(key, { type }),
    renameQuestion(key, next) {
      model.updateQuestion(key, { key: next });
      return model.state.a.questions.some((q) => q.key === next);
    },
    removeQuestion: (key) => model.removeQuestion(key),
    updateText: (key, text) => model.updateQuestion(key, { text }),
    updateItem: (many, key, id, patch) => (many === 'options' ? model.updateOption(key, id, patch) : model.updateLevel(key, id, patch)),
    moveItem: (many, key, id, d) => (many === 'options' ? model.moveOption(key, id, d) : model.moveLevel(key, id, d)),
    removeItem: (many, key, id) => (many === 'options' ? model.removeOption(key, id) : model.removeLevel(key, id)),
    addItem: (many, key) => (many === 'options' ? model.addOption(key) : model.addLevel(key)),
  };
}

function opsForB(model) {
  const e = model.edits;
  const b = (fn) => model.editVariant(fn);
  const updateText = (key, text) => b((run) => {
    const q = e.find(run, key);
    if (q) q.text = text;
  });
  return {
    retype() {},
    renameQuestion: () => false,
    removeQuestion() {},
    updateText,
    updateItem: (many, key, id, patch) => b((run) => e[many].update(run, key, id, patch)),
    moveItem: (many, key, id, d) => b((run) => e[many].move(run, key, id, d)),
    removeItem: (many, key, id) => b((run) => e[many].remove(run, key, id)),
    addItem: (many, key) => b((run) => e[many].add(run, key)),
  };
}

function errorNotice(text) {
  return h('div', { class: 'oc-notice oc-notice--danger ms-inline-notice', role: 'alert' }, icon('danger'), h('span', { class: 'oc-notice__text' }, text));
}

function situationField(value, id, onText) {
  return h('div', { class: 'oc-field' },
    h('label', { for: id }, 'Situation'),
    h('textarea', { class: 'oc-input ms-situation', id, rows: '4', 'data-fid': `${id}`, oninput: (e) => onText(e.target.value) }, value),
  );
}

export function createBenchView(deps = {}) {
  let model = null;
  let root = null;
  let off = null;
  let quiet = false;
  let showIO = false;
  let spinner = false;
  let spinnerTimer = null;
  let lastBusy = null;
  let setups = [...BUILTIN];
  let store = null;
  const hosts = {};

  // Typing goes through here: the model changes, the form is left alone.
  const typing = (fn) => (...args) => {
    quiet = true;
    try {
      fn(...args);
    } finally {
      quiet = false;
    }
  };

  const wrapOps = (ops) => {
    const out = { ...ops };
    for (const name of ['updateText', 'updateItem']) out[name] = typing(ops[name]);
    out.renameQuestion = (...args) => {
      let ok = false;
      typing(() => (ok = ops.renameQuestion(...args)))();
      return ok;
    };
    return out;
  };

  function setupPicker() {
    const select = h('select', {
      'aria-label': 'Load a setup',
      onchange: (e) => {
        const setup = setups.find((s) => s.id === e.target.value);
        if (!setup) return;
        model.loadSetup(setup);
        hosts.picker.replaceChildren(setupPicker());
        hosts.picker.querySelector('[data-fid="setup"]')?.focus({ preventScroll: true });
      },
    },
    h('option', { value: '', selected: true }, 'Load a setup'),
    setups.map((s) => h('option', { value: s.id }, s.name)));
    const control = picker(select);
    (control.querySelector?.('button') ?? control).setAttribute('data-fid', 'setup');
    return control;
  }

  // "Save as setup": a name field and Save appear in place of the button.
  function saveAsControl(open = false, problem = null) {
    if (!open) {
      return h('button', { type: 'button', class: 'oc-btn', 'data-fid': 'save-as', onclick: () => {
        hosts.saveAs.replaceChildren(saveAsControl(true));
        hosts.saveAs.querySelector('input')?.focus({ preventScroll: true });
      } }, 'Save as setup');
    }
    const input = h('input', { type: 'text', class: 'oc-input', 'aria-label': 'Setup name', 'data-fid': 'save-as-name', autocomplete: 'off' });
    const close = () => {
      hosts.saveAs.replaceChildren(saveAsControl());
      hosts.saveAs.querySelector('button')?.focus({ preventScroll: true });
    };
    // One save at a time: a second Enter or click while the first is on its way does nothing.
    let saving = false;
    const submit = async (e) => {
      e.preventDefault();
      if (saving) return;
      const setup = fromRun(model.state.a, input.value.trim());
      const text = validateSetup(setup);
      if (text) {
        hosts.saveAs.replaceChildren(saveAsControl(true, text));
        hosts.saveAs.querySelector('input').value = input.value;
        hosts.saveAs.querySelector('input').focus({ preventScroll: true });
        return;
      }
      saving = true;
      try {
        await store.saveSetup(setup);
      } catch (err) {
        hosts.saveAs.replaceChildren(saveAsControl(true, messageOf(err)));
        hosts.saveAs.querySelector('input').value = input.value;
        return;
      } finally {
        saving = false;
      }
      setups = [...setups.filter((s) => s.id !== setup.id), setup];
      hosts.picker.replaceChildren(setupPicker());
      close();
      deps.notify?.(`Saved '${setup.name}'`);
    };
    return h('form', { class: 'ms-save-as', onsubmit: submit },
      h('div', { class: 'oc-row' },
        input,
        h('button', { type: 'submit', class: 'oc-btn' }, 'Save'),
        h('button', { type: 'button', class: 'oc-btn oc-btn--icon', 'aria-label': 'Cancel', 'data-oc-tip': 'Cancel', onclick: close }, icon('x')),
      ),
      problem ? errorNotice(problem) : null,
    );
  }

  function renderForm(state) {
    hosts.form.replaceChildren(
      situationField(state.a.state, 'bench-situation', typing((v) => model.setState(v))),
      h('div', { class: 'ms-cards' }, questionCards(state.a, wrapOps(opsForA(model)))),
      h('div', { class: 'oc-row' },
        h('button', { type: 'button', class: 'oc-btn', 'data-fid': 'add-question', disabled: state.a.questions.length >= LIMITS.questions, onclick: () => model.addQuestion('noul') },
          icon('plus'), 'Add question'),
      ),
    );
  }

  // Run and the variant menu stay focusable while a run is in flight (aria-disabled); the
  // model ignores runs while busy. They are rebuilt only when what they show changes.
  let actionsKey = null;
  function renderActions(state) {
    const key = [state.busy, spinner, Boolean(state.resultA), state.variant].join('|');
    if (key === actionsKey) return;
    actionsKey = key;
    const run = h('button', {
      type: 'button',
      class: 'oc-btn oc-btn--primary',
      'data-fid': 'run',
      'data-oc-tip': 'Run (Ctrl+Enter)',
      'aria-busy': state.busy === 'a' && spinner ? 'true' : null,
      'aria-disabled': state.busy ? 'true' : null,
      onclick: () => model.run(),
    }, 'Run');
    const variant = menuButton('Run a variant', [
      { label: 'Edit a copy', run: () => model.startVariant() },
      ...VARIANTS.map((v) => ({
        label: v.label,
        run: () => {
          model.startVariant(v.id);
          model.runVariant();
        },
      })),
    ], { disabled: !state.resultA, busy: Boolean(state.busy) });
    const vbutton = variant.querySelector('button');
    vbutton.setAttribute('data-fid', 'variant');
    if (state.busy === 'b' && spinner && state.variant) vbutton.setAttribute('aria-busy', 'true');
    hosts.actions.replaceChildren(h('div', { class: 'oc-row ms-actions' }, run, variant));
  }

  // Each run's error sits beside it: A's above Run, B's in B's editor or above the results.
  // A notice is replaced only when its sentence changes or a new run attempt ends.
  const shown = { a: null, b: null };
  function renderErrors(state, attemptEnded) {
    for (const which of ['a', 'b']) {
      const text = state.error && state.errorFor === which ? state.error : null;
      if (text === shown[which] && !attemptEnded) continue;
      shown[which] = text;
      hosts[`error${which.toUpperCase()}`].replaceChildren(...(text ? [errorNotice(text)] : []));
    }
  }

  // B's own editor, above its column, when "Edit a copy" was chosen.
  function renderVariant(state) {
    if (!state.b || state.variant !== null) {
      hosts.variant.replaceChildren(hosts.errorB);
      return;
    }
    hosts.variant.replaceChildren(
      h('section', { class: 'ms-variant', 'data-variant-editor': '' },
        h('div', { class: 'ms-variant__head' },
          h('h2', { class: 'ms-result__title' }, variantLabel(null)),
          h('button', { type: 'button', class: 'oc-btn oc-btn--icon', 'aria-label': 'Drop variant', 'data-oc-tip': 'Drop variant', 'data-fid': 'drop-b', onclick: () => model.dropVariant() }, icon('x')),
        ),
        situationField(state.b.state, 'bench-situation-b', typing((v) => model.editVariant((b) => { b.state = v; }))),
        h('div', { class: 'ms-cards' }, questionCards(state.b, wrapOps(opsForB(model)), { locked: true, slotsFor: (q) => colorSlots(state.ranA?.questions.find((x) => x.key === q.key), q) })),
        hosts.errorB,
        h('div', { class: 'oc-row' },
          h('button', {
            type: 'button',
            class: 'oc-btn',
            'data-fid': 'run-b',
            'data-oc-tip': 'Run B (Ctrl+Enter)',
            'aria-busy': state.busy === 'b' && spinner ? 'true' : null,
            'aria-disabled': state.busy ? 'true' : null,
            onclick: () => model.runVariant(),
          }, 'Run B'),
        ),
      ),
    );
  }

  function renderResults(state) {
    hosts.results.replaceChildren(...resultsSection(state, model.diff(), {
      mode: deps.mode,
      showIO,
      notify: deps.notify,
      toggleIO: () => {
        showIO = !showIO;
        renderResults(model.state);
      },
    }));
  }

  // After a rebuild, focus goes back to the same control, or the nearest one that still exists.
  function refocus(fid) {
    if (!fid) return;
    const card = fid.split(':')[0];
    for (const f of [fid, `${card}:add`, `${card}:text`, 'add-question']) {
      const el = root.querySelector(`[data-fid="${f}"]`);
      if (el && !el.disabled) {
        el.focus({ preventScroll: true });
        return;
      }
    }
  }

  const focusedFid = () => (root.contains(document.activeElement) ? document.activeElement.getAttribute('data-fid') : null);
  const keepFocus = (fn) => {
    const fid = focusedFid();
    fn();
    if (fid && !root.contains(document.activeElement)) refocus(fid);
  };

  // Returns true when a run attempt just ended.
  function trackBusy(state) {
    if (state.busy === lastBusy) return false;
    const ended = lastBusy !== null && state.busy === null;
    lastBusy = state.busy;
    clearTimeout(spinnerTimer);
    spinner = false;
    if (state.busy) {
      spinnerTimer = setTimeout(() => {
        spinner = true;
        keepFocus(() => renderActions(model.state));
        if (model.state.busy === 'b') root?.querySelector('[data-fid="run-b"]')?.setAttribute('aria-busy', 'true');
      }, SPINNER_AFTER_MS);
    }
    return ended;
  }

  function render(state) {
    keepFocus(() => {
      const ended = trackBusy(state);
      renderActions(state);
      if (!quiet) {
        renderForm(state);
        renderVariant(state);
        renderResults(state);
      }
      renderErrors(state, ended);
    });
  }

  const onKey = (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (e.target.closest?.('[data-variant-editor]')) model.runVariant();
    else model.run();
  };

  return {
    mount(el, ctx) {
      root = el;
      showIO = false;
      setups = [...BUILTIN];
      root.classList.add('oc-columns--split', 'ms-bench');
      deps = { ...deps, mode: ctx.mode, notify: ctx.notify };
      store = ctx.store;
      model = createBenchModel({ client: ctx.client, store: ctx.store, mode: ctx.mode, navigate: ctx.navigate });
      // A run handed over (by the guide, Setups or History) replaces the one kept from last time.
      const queued = takeRun();
      if (queued) model.loadRun(queued.run, queued.result);
      hosts.picker = h('div', { class: 'ms-setup-picker' }, setupPicker());
      hosts.saveAs = h('div', { class: 'ms-save-as-host' }, saveAsControl());
      hosts.form = h('div', { class: 'oc-stack' });
      hosts.errorA = h('div', { class: 'ms-error-host' });
      hosts.errorB = h('div', { class: 'ms-error-host' });
      actionsKey = null;
      shown.a = null;
      shown.b = null;
      hosts.actions = h('div', { class: 'oc-stack ms-actions-host' });
      hosts.variant = h('div', {});
      hosts.results = h('div', {});
      root.append(
        h('section', { class: 'ms-setup', 'aria-label': 'Setup' },
          h('header', { class: 'oc-page-head' }, h('h1', { class: 'oc-text-page', tabindex: '-1' }, 'Bench'), h('div', { class: 'oc-row ms-head-tools' }, hosts.picker, hosts.saveAs)),
          hosts.form,
          hosts.errorA,
          hosts.actions,
        ),
        h('section', { class: 'ms-output', 'aria-label': 'Results' }, hosts.variant, hosts.results),
      );
      root.addEventListener('keydown', onKey);
      off = model.subscribe(render);
      render(model.state);
      Promise.resolve(ctx.store?.listSetups?.())
        .then((own) => {
          if (!root || !Array.isArray(own) || own.length === 0) return;
          setups = [...BUILTIN, ...own];
          hosts.picker.replaceChildren(setupPicker());
        })
        .catch(() => {});
    },
    // The setup as entered, for the guided view when the user switches over.
    currentRun: () => (model ? JSON.parse(JSON.stringify(model.state.a)) : null),
    unmount() {
      off?.();
      clearTimeout(spinnerTimer);
      root?.removeEventListener('keydown', onKey);
      root = null;
      model = null;
    },
  };
}
