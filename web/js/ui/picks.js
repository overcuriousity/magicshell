import { h } from './dom.js';

export function picksRow({ label, items, onPick, fid = '', limit = 5 }) {
  const labelEl = h('span', { class: 'ms-complete__label' }, label);
  const el = h('div', { class: 'ms-complete__row' }, labelEl);
  const refresh = () => {
    const choices = items().slice(0, limit);
    el.hidden = choices.length === 0;
    el.replaceChildren(labelEl, ...choices.map(({ text, value }, i) => {
      const button = h('button', {
        type: 'button',
        class: 'oc-btn ms-complete__pick',
        title: text,
        'data-fid': fid ? `${fid}-pick-${i}` : null,
        onclick: () => {
          onPick?.(value);
          button.remove();
        },
      }, text);
      return button;
    }));
  };
  refresh();
  return { el, refresh };
}
