// Setups: built-in ones first, then the user's by name. Own setups can be edited (name, sample
// situation, question cards), deleted with an undo, exported and imported. From 90rem the list and
// the editor sit side by side; below, the editor replaces the list.
import { LIMITS } from '../limits.js';
import { messageOf } from '../run-error.js';
import { BUILTIN } from '../setups-builtin.js';
import { exportSetups, importSetups, validateSetup } from '../transfer.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { questionCards } from './bench-cards.js';
import { queueRun, runEdits } from './bench-model.js';
import { duplicate } from './setup-model.js';

const copy = (v) => JSON.parse(JSON.stringify(v));
const byName = (a, b) => a.name.localeCompare(b.name);
const emptyDraft = (uuid) => ({ id: uuid(), name: '', sampleState: '', questions: [{ key: 'q1', type: 'noul', text: '' }] });

function errorNotice(text) {
  return h('div', { class: 'oc-notice oc-notice--danger ms-inline-notice', role: 'alert' }, icon('danger'), h('span', { class: 'oc-notice__text' }, text));
}

const plural = (n) => `${n} setup${n === 1 ? '' : 's'}`;

function download(text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: 'magicshell-setups.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createSetupsView({ uuid = () => crypto.randomUUID() } = {}) {
  let root = null;
  let ctx = null;
  let own = [];
  let loaded = false;
  let draft = null;
  let editError = null;
  let hosts = {};
  const edits = runEdits(uuid);

  const notify = (text, opts) => ctx.notify(text, opts);
  const fail = (e) => notify(messageOf(e), { kind: 'danger' });

  async function reload() {
    own = (await ctx.store.listSetups()).slice().sort(byName);
    loaded = true;
    if (root) renderList();
  }

  function openInBench(setup) {
    queueRun({ state: setup.sampleState ?? '', questions: copy(setup.questions) });
    ctx.navigate('#/ask/bench');
  }

  async function remove(setup) {
    try {
      await ctx.store.deleteSetup(setup.id);
      await reload();
    } catch (e) {
      fail(e);
      return;
    }
    if (root && draft?.id === setup.id) closeEditor();
    notify(`Deleted '${setup.name}'`, {
      action: {
        label: 'Undo',
        run: async () => {
          try {
            await ctx.store.saveSetup(setup);
            if (root) await reload();
          } catch (e) {
            fail(e);
          }
        },
      },
    });
  }

  async function duplicateSetup(setup) {
    try {
      await ctx.store.saveSetup(duplicate(setup, uuid));
      await reload();
    } catch (e) {
      fail(e);
    }
  }

  function questionList(setup) {
    return h('ul', { class: 'ms-qlist' },
      setup.questions.map((q) => h('li', {}, h('span', { class: 'ms-type' }, q.type), h('span', { class: 'ms-qlist__text' }, q.text || q.key))));
  }

  function row(setup) {
    const act = (label, fn, cls = 'oc-btn') => h('button', { type: 'button', class: cls, onclick: fn }, label);
    return h('li', { class: 'ms-setup-row', 'data-setup': setup.id },
      h('h3', { class: 'ms-setup-row__name' }, setup.name),
      questionList(setup),
      h('div', { class: 'oc-row ms-setup-row__acts' },
        act('Open in bench', () => openInBench(setup)),
        setup.builtin ? null : act('Edit', () => openEditor(setup)),
        act('Duplicate', () => duplicateSetup(setup)),
        setup.builtin ? null : act('Delete', () => remove(setup)),
      ),
    );
  }

  function renderList() {
    const fileInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      hidden: true,
      onchange: (e) => importFile(e.target.files?.[0]).finally(() => { e.target.value = ''; }),
    });
    hosts.list.replaceChildren(
      h('header', { class: 'oc-page-head' }, h('h1', { class: 'oc-text-page', tabindex: '-1' }, 'Setups')),
      h('div', { class: 'oc-row ms-actions' },
        h('button', { type: 'button', class: draft ? 'oc-btn' : 'oc-btn oc-btn--primary', 'data-fid': 'new', onclick: () => openEditor(null) }, icon('plus'), 'New setup'),
        h('button', { type: 'button', class: 'oc-btn', onclick: () => fileInput.click() }, icon('upload'), 'Import'),
        h('button', { type: 'button', class: 'oc-btn', disabled: own.length === 0, onclick: () => download(exportSetups(own)) }, icon('download'), 'Export'),
        fileInput,
      ),
      h('ul', { class: 'ms-setup-list' }, [...BUILTIN, ...own].map(row)),
      ...(loaded && own.length === 0 ? [h('p', { class: 'ms-empty' }, 'No setups of your own yet.')] : []),
    );
  }

  async function importFile(file) {
    if (!file) return;
    try {
      const { setups, skipped } = importSetups(await file.text(), uuid);
      for (const s of setups) await ctx.store.saveSetup(s);
      await reload();
      notify(skipped ? `Imported ${plural(setups.length)}, skipped ${skipped}` : `Imported ${plural(setups.length)}`);
    } catch (e) {
      fail(e);
    }
  }

  // ---- editor ----
  function openEditor(setup) {
    draft = setup ? copy(setup) : emptyDraft(uuid);
    editError = null;
    root.classList.add('ms-editing');
    renderList();
    renderEditor();
    hosts.editor.querySelector('[data-fid="name"]')?.focus({ preventScroll: true });
  }

  function closeEditor(focus = true) {
    draft = null;
    editError = null;
    root.classList.remove('ms-editing');
    hosts.editor.replaceChildren();
    renderList();
    if (focus) hosts.list.querySelector('[data-fid="new"]')?.focus({ preventScroll: true });
  }

  const rebuild = (fn) => {
    const fid = hosts.editor.contains(document.activeElement) ? document.activeElement.getAttribute('data-fid') : null;
    fn();
    renderEditor();
    if (!fid) return;
    const card = fid.split(':')[0];
    for (const f of [fid, `${card}:add`, `${card}:text`, 'add-question']) {
      const el = hosts.editor.querySelector(`[data-fid="${f}"]`);
      if (el && !el.disabled) {
        el.focus({ preventScroll: true });
        return;
      }
    }
  };

  function ops() {
    const items = (many) => edits[many];
    return {
      retype: (key, type) => rebuild(() => edits.retype(edits.find(draft, key), type)),
      renameQuestion(key, next) {
        if (next !== key && edits.find(draft, next)) {
          setError('Name each question differently.');
          return false;
        }
        const q = edits.find(draft, key);
        if (q) q.key = next;
        if (editError === 'Name each question differently.') setError(null);
        return Boolean(q);
      },
      removeQuestion: (key) => rebuild(() => { draft.questions = draft.questions.filter((q) => q.key !== key); }),
      updateText(key, text) {
        const q = edits.find(draft, key);
        if (q) q.text = text;
      },
      updateItem: (many, key, id, patch) => items(many).update(draft, key, id, patch),
      moveItem: (many, key, id, d) => rebuild(() => items(many).move(draft, key, id, d)),
      removeItem: (many, key, id) => rebuild(() => items(many).remove(draft, key, id)),
      addItem: (many, key) => rebuild(() => items(many).add(draft, key)),
    };
  }

  function setError(text) {
    editError = text;
    hosts.error?.replaceChildren(...(text ? [errorNotice(text)] : []));
  }

  async function save() {
    const setup = { id: draft.id, name: draft.name.trim(), sampleState: draft.sampleState, questions: copy(draft.questions) };
    const problem = validateSetup(setup);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      await ctx.store.saveSetup(setup);
    } catch (e) {
      setError(messageOf(e));
      return;
    }
    if (!root) return;
    closeEditor(false);
    await reload();
    hosts.list?.querySelector(`[data-setup="${CSS.escape(setup.id)}"] button`)?.focus({ preventScroll: true });
  }

  function renderEditor() {
    hosts.error = h('div', { class: 'ms-error-host' });
    hosts.editor.replaceChildren(
      h('section', { class: 'ms-setup ms-editor', 'aria-label': 'Edit setup' },
        h('header', { class: 'oc-page-head' },
          h('button', { type: 'button', class: 'oc-btn ms-back', 'data-fid': 'back', onclick: () => closeEditor() }, 'Back'),
          h('h2', { class: 'oc-text-section' }, 'Setup'),
        ),
        h('div', { class: 'oc-stack' },
          h('div', { class: 'oc-field' },
            h('label', { for: 'setup-name' }, 'Name'),
            h('input', { type: 'text', class: 'oc-input', id: 'setup-name', 'data-fid': 'name', value: draft.name, autocomplete: 'off', oninput: (e) => { draft.name = e.target.value; } }),
          ),
          h('div', { class: 'oc-field' },
            h('label', { for: 'setup-situation' }, 'Sample situation'),
            h('textarea', { class: 'oc-input ms-situation', id: 'setup-situation', rows: '4', 'data-fid': 'situation', oninput: (e) => { draft.sampleState = e.target.value; } }, draft.sampleState),
          ),
          h('div', { class: 'ms-cards' }, questionCards(draft, ops())),
          h('div', { class: 'oc-row' },
            h('button', { type: 'button', class: 'oc-btn', 'data-fid': 'add-question', disabled: draft.questions.length >= LIMITS.questions, onclick: () => rebuild(() => draft.questions.push(edits.newQuestion(draft, 'noul'))) },
              icon('plus'), 'Add question'),
          ),
        ),
        hosts.error,
        h('div', { class: 'oc-row ms-actions' },
          h('button', { type: 'button', class: 'oc-btn oc-btn--primary', 'data-fid': 'save', onclick: save }, 'Save'),
        ),
      ),
    );
    if (editError) setError(editError);
  }

  return {
    mount(el, c) {
      root = el;
      ctx = c;
      own = [];
      loaded = false;
      draft = null;
      root.classList.add('oc-columns--split', 'ms-setups');
      hosts = { list: h('section', { class: 'ms-list', 'aria-label': 'Setups' }), editor: h('div', { class: 'ms-editor-host' }) };
      root.append(hosts.list, hosts.editor);
      renderList();
      reload().catch(fail);
    },
    unmount() {
      // ctx stays: an Undo or a save still in flight finishes against the store after leaving.
      root = null;
      draft = null;
    },
  };
}
