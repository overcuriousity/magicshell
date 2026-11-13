// The bench's result side: one block per question (A, or A beside B with what moved), the run
// figures, and the request and response of each run as indented JSON with copy buttons.
import { signed } from '../format.js';
import { prettyJson } from '../json-text.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { answerResult } from '../ui/results.js';
import { VARIANTS } from '../variants.js';

export function variantLabel(variant) {
  const ready = VARIANTS.find((v) => v.id === variant);
  return ready ? `B · ${ready.label.toLowerCase()}` : 'B · edited copy';
}

// Changes per bar of B against A, matched by option or level id; null where A has no such row.
function barDeltas(qa, a, qb, b) {
  const field = qa.type === 'choice' ? 'options' : 'levels';
  const before = new Map(qa[field].map((x, i) => [x.id, a.probabilities[i]]));
  return qb[field].map((x, i) => (before.has(x.id) ? b.probabilities[i] - before.get(x.id) : null));
}

// For each row of B's question, the position of the same option or level in A (by id).
export function colorSlots(qa, qb) {
  const field = qa?.type === 'choice' ? 'options' : qa?.type === 'score' ? 'levels' : null;
  if (!field || !qb?.[field]) return null;
  const at = new Map(qa[field].map((x, i) => [x.id, i]));
  return qb[field].map((x, i) => at.get(x.id) ?? i);
}

function deltaLine(qa, d) {
  const parts = [];
  if (d.pickChanged) parts.push(icon('warning', 'row'), h('span', {}, 'pick changed'));
  let change = null;
  if (qa.type === 'score' && d.scoreDelta !== null && d.scoreDelta !== undefined) change = signed(d.scoreDelta);
  if (qa.type === 'noul') change = `yes ${signed(d.delta)}`;
  if (change) parts.push(h('span', {}, d.pickChanged ? `· ${change}` : change));
  return parts.length ? h('div', { class: 'ms-delta' }, parts) : null;
}

function block(qa, state, d, variant) {
  const a = state.resultA.answers[qa.key];
  const title = qa.text.trim() ? `${qa.key} · ${qa.text.trim()}` : qa.key;
  const qb = state.ranB?.questions.find((q) => q.key === qa.key);
  const b = state.resultB?.answers[qa.key];
  if (!qb || !b) return h('section', { class: 'ms-result' }, h('h2', { class: 'ms-result__title' }, title), answerResult(qa, a));
  const deltas = d && qa.type !== 'noul' ? { deltas: barDeltas(qa, a, qb, b) } : {};
  // An option or level keeps its colour from A wherever B moved it.
  const colors = colorSlots(qa, qb);
  if (colors) deltas.colors = colors;
  return h('section', { class: 'ms-result' },
    h('h2', { class: 'ms-result__title' }, title),
    h('div', { class: 'ms-ab' },
      h('div', {}, h('div', { class: 'ms-ab__head' }, 'A · baseline'), answerResult(qa, a)),
      h('div', {}, h('div', { class: 'ms-ab__head' }, variantLabel(variant)), answerResult(qb, b, deltas), d ? deltaLine(qa, d) : null),
    ),
  );
}

const ms = (v) => `${Math.round(v)} ms`;

function runLine(result, mode) {
  const parts = [ms(result.totalMs)];
  if (mode !== 'pages' && typeof result.upstreamMs === 'number') parts.push(`${ms(result.upstreamMs)} at the model`);
  parts.push(`${result.inputTokens} tokens`);
  if (result.model) parts.push(result.model);
  return parts.join(' · ');
}

function copyButton(text, label, notify) {
  const button = h('button', {
    type: 'button',
    class: 'oc-btn oc-btn--icon oc-copy',
    'aria-label': label,
    'data-oc-tip': label,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        notify?.('Could not copy. Select the text instead.', { kind: 'warning' });
        return;
      }
      button.setAttribute('data-copied', '');
      notify?.('Copied', { kind: 'success', ms: 1500 });
      setTimeout(() => button.removeAttribute('data-copied'), 1500);
    },
  }, icon('copy'), icon('check'));
  return button;
}

function jsonPane(head, text, notify) {
  const pretty = prettyJson(text ?? '');
  return h('div', { class: 'ms-io' },
    h('div', { class: 'ms-io__head' }, h('span', {}, head), copyButton(pretty, `Copy ${head}`, notify)),
    h('pre', { class: 'ms-io__body', tabindex: '0' }, h('code', {}, pretty)),
  );
}

// view: { mode, showIO, toggleIO(), notify }
export function resultsSection(state, diff, view) {
  if (!state.resultA) return [];
  const withB = Boolean(state.resultB);
  const runs = [['A', state.resultA]];
  if (withB) runs.push(['B', state.resultB]);
  const blocks = state.ranA.questions.map((qa) => block(qa, state, diff?.[qa.key] ?? null, state.variant));
  const lines = runs.map(([name, r]) => h('div', {}, withB ? `${name} · ${runLine(r, view.mode)}` : runLine(r, view.mode)));
  const panes = view.showIO
    ? h('div', { class: 'ms-ios', id: 'bench-io' },
        runs.flatMap(([name, r]) => {
          const prefix = withB ? `${name} ` : '';
          return [jsonPane(`${prefix}request`, r.request, view.notify), jsonPane(`${prefix}response`, r.response, view.notify)];
        }))
    : null;
  return [
    h('div', { class: 'ms-results' }, blocks),
    h('div', { class: 'ms-runinfo' }, lines),
    h('div', { class: 'ms-io-toggle' },
      h('button', {
        type: 'button',
        class: 'oc-btn',
        'aria-expanded': String(view.showIO),
        'aria-controls': 'bench-io',
        'data-fid': 'io',
        onclick: view.toggleIO,
      }, icon(view.showIO ? 'chevron-up' : 'chevron-down'), view.showIO ? 'Hide request and response' : 'Show request and response'),
    ),
    panes,
  ].filter(Boolean);
}
