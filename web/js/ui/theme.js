// Theme (system, light, dark) and text size (default, compact), kept in localStorage.
// theme-boot.js applies the stored values before first paint; this module changes them.
const THEMES = ['system', 'light', 'dark'];
const THEME_KEY = 'magicshell.theme';
const TEXT_SIZE_KEY = 'magicshell.textsize';
export const THEME_LABELS = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };

const defaultRoot = () => globalThis.document?.documentElement;
function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // storage blocked: the choice holds for this page only
  }
}

export function nextTheme(current) {
  const i = Math.max(0, THEMES.indexOf(current));
  return THEMES[(i + 1) % THEMES.length];
}

export function storedTheme(storage = defaultStorage()) {
  const v = read(storage, THEME_KEY);
  return THEMES.includes(v) ? v : 'system';
}

export function storedTextSize(storage = defaultStorage()) {
  return read(storage, TEXT_SIZE_KEY) === 'compact' ? 'compact' : 'default';
}

export function applyTheme(name, { root = defaultRoot(), storage = defaultStorage() } = {}) {
  const theme = THEMES.includes(name) ? name : 'system';
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  write(storage, THEME_KEY, theme);
  return theme;
}

export function applyTextSize(size, { root = defaultRoot(), storage = defaultStorage() } = {}) {
  const value = size === 'compact' ? 'compact' : 'default';
  if (value === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
  write(storage, TEXT_SIZE_KEY, value);
  return value;
}
