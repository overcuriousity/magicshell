// Notices: a status symbol and the text, separated by hairlines, an optional action at the end.
// They hide after `ms` and pause while hovered or focused.
import { h } from './dom.js';
import { icon } from './icons.js';

const KINDS = ['info', 'success', 'warning', 'danger'];

export function notify(text, { action, ms = 6000, kind = 'info', region } = {}) {
  const host = region ?? document.getElementById('notices');
  const k = KINDS.includes(kind) ? kind : 'info';
  let done = false;
  let timer = null;
  let left = ms;
  let started = 0;
  let hovered = false;
  let focused = false;

  const dismiss = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    el.remove();
  };
  const start = () => {
    started = Date.now();
    timer = setTimeout(dismiss, left);
  };
  const pause = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    left = Math.max(0, left - (Date.now() - started));
  };
  const resume = () => {
    if (done || hovered || focused || timer !== null) return;
    start();
  };

  const button = action
    ? h('button', {
        type: 'button',
        class: 'oc-btn',
        onclick: () => {
          if (done) return;
          dismiss();
          action.run();
        },
      }, action.label)
    : null;
  const el = h('div', { class: `oc-notice oc-notice--${k}` }, icon(k), h('span', { class: 'oc-notice__text' }, text), button);
  el.addEventListener('mouseenter', () => { hovered = true; pause(); });
  el.addEventListener('mouseleave', () => { hovered = false; resume(); });
  el.addEventListener('focusin', () => { focused = true; pause(); });
  el.addEventListener('focusout', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    focused = false;
    resume();
  });

  host.append(el);
  start();
  return { dismiss };
}
