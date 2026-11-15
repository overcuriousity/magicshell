// The one way views build elements: h('button', { class: 'oc-btn', onclick }, 'Run').
// Attributes are set as attributes; on* functions become listeners; null, undefined and false are left out.
// The nodes of a list that are there: a browser turns a null handed to append or replaceChildren
// into the text "null", so lists that may hold one go through here (h() already drops them).
export const present = (nodes) => nodes.filter((n) => n != null && n !== false);

// Where the caret is in a text field, to put it back on the field a rebuild puts in its place;
// null for anything without one. An uncontrolled draft also needs its value restored before the caret.
export function caretOf(el, { value = false } = {}) {
  try {
    if (el == null || typeof el.selectionStart !== 'number') return null;
    const caret = { start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop ?? 0 };
    if (value) caret.value = el.value;
    return caret;
  } catch {
    return null;
  }
}
export function restoreCaret(el, caret) {
  if (!el || !caret) return;
  try {
    if (Object.hasOwn(caret, 'value')) el.value = caret.value;
    el.setSelectionRange(caret.start, caret.end);
    el.scrollTop = caret.scroll;
  } catch {
    // Not a text field after all.
  }
}

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
