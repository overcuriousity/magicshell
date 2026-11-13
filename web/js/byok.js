// Mode 1: the visitor's own endpoint, key and model, kept in this browser under magicshell.byok.
import { normaliseEndpoint } from './mode.js';

export const BYOK_KEY = 'magicshell.byok';
const NO_MODEL = 'Name the model to ask.';

export function loadByok(storage) {
  try {
    const v = JSON.parse(storage?.getItem(BYOK_KEY) ?? 'null');
    if (v && typeof v.endpoint === 'string' && v.endpoint && typeof v.model === 'string' && v.model) {
      return { endpoint: v.endpoint, key: typeof v.key === 'string' ? v.key : '', model: v.model };
    }
  } catch {
    // Unreadable settings count as none.
  }
  return null;
}

// The values as they are kept, or the sentence that refuses them.
export function checkByok({ endpoint, key, model }) {
  const checked = normaliseEndpoint(endpoint);
  if (checked.error) return { error: checked.error };
  const name = String(model ?? '').trim();
  if (!name) return { error: NO_MODEL };
  return { value: { endpoint: checked.url, key: String(key ?? '').trim(), model: name } };
}

// Checks and stores the values: { error } when refused, else { value, kept } where kept is false
// when the browser would not write them (the value still holds for this page).
export function applyByok(storage, values) {
  const checked = checkByok(values);
  if (checked.error) return { error: checked.error };
  let kept = Boolean(storage);
  try {
    storage?.setItem(BYOK_KEY, JSON.stringify(checked.value));
  } catch {
    kept = false;
  }
  return { value: checked.value, kept };
}

// null when the values are fine (kept if the browser allows), else the sentence that refuses them.
export function saveByok(storage, values) {
  return applyByok(storage, values).error ?? null;
}
