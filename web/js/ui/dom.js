// The one way views build elements: h('button', { class: 'oc-btn', onclick }, 'Run').
// Attributes are set as attributes; on* functions become listeners; null, undefined and false are left out.
// The nodes of a list that are there: a browser turns a null handed to append or replaceChildren
// into the text "null", so lists that may hold one go through here (h() already drops them).
export const present = (nodes) => nodes.filter((n) => n != null && n !== false);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (typeof c === 'number' ? String(c) : c)));
  return el;
}
