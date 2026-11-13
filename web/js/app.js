// The app shell: top bar, navigation (top from 48rem, tab bar below), and the view of the current route.
// Views register as { mount(el, ctx), unmount() }; until a later task adds one, a destination shows its heading.
import { createDirectClient } from './client-direct.js';
import { createServerClient } from './client-server.js';
import { detectMode } from './mode.js';
import { RunError } from './run-error.js';
import { createBrowserStore } from './store-browser.js';
import { createServerStore } from './store-server.js';
import { h } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { notify } from './ui/notice.js';
import { applyTextSize, applyTheme, nextTheme, storedTextSize, storedTheme, THEME_LABELS } from './ui/theme.js';
import { createBenchView } from './views/bench.js';
import { createGuidedView } from './views/guided.js';
import { createHistoryView } from './views/history.js';
import { createSetupsView } from './views/setups.js';

export const DESTINATIONS = [
  { view: 'ask', label: 'Ask', icon: 'ask' },
  { view: 'history', label: 'History', icon: 'history' },
  { view: 'setups', label: 'Setups', icon: 'setups' },
  { view: 'settings', label: 'Settings', icon: 'settings' },
];
const TITLES = { ...Object.fromEntries(DESTINATIONS.map((d) => [d.view, d.label])), 'sign-in': 'Sign in' };

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// "#/history/abc" -> { view: "history", id: "abc" }; anything unknown opens Ask.
export function route(hash) {
  const m = /^#\/([^/]*)(?:\/(.*))?$/.exec(hash ?? '');
  if (!m || !Object.hasOwn(TITLES, m[1])) return { view: 'ask' };
  return m[2] ? { view: m[1], id: decode(m[2]) } : { view: m[1] };
}

export const hrefOf = (view, id) => (id == null ? `#/${view}` : `#/${view}/${encodeURIComponent(id)}`);

function placeholder(view) {
  return {
    mount(el) {
      el.append(h('header', { class: 'oc-page-head' }, h('h1', { class: 'oc-text-page', tabindex: '-1' }, TITLES[view])));
    },
    unmount() {},
  };
}

const registry = new Map();
export function registerView(name, view) {
  registry.set(name, view);
}
const viewFor = (name) => registry.get(name) ?? placeholder(name);

// Ask: the guided view at #/ask (and on every fresh load), the bench at #/ask/bench. The switch
// in the top bar carries what was entered over; "something else" in the guide opens the bench.
export const isBench = (r) => r.view === 'ask' && r.id === 'bench';
export const ASK_HREF = { guided: '#/ask', bench: '#/ask/bench' };

export function createAskView({ guided = createGuidedView(), bench = createBenchView() } = {}) {
  let current = null;
  let slot = null;
  // { to: 'bench' | 'guided', run }, taken by the next mount of that side only.
  let carry = null;
  return {
    mount(el, ctx) {
      const side = isBench(ctx.route) ? 'bench' : 'guided';
      const other = side === 'bench' ? 'guided' : 'bench';
      const handed = carry?.to === side ? carry.run : null;
      carry = null;
      current = side === 'bench' ? bench : guided;
      slot = ctx.modeSwitch ?? null;
      slot?.replaceChildren(
        h('a', { href: ASK_HREF[other], class: 'ms-switch', onclick: (e) => {
          // A plain primary click only: a modifier-click opens a new tab and must leave nothing behind.
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          carry = { to: other, run: current.currentRun() };
        } },
          other === 'bench' ? 'Bench' : 'Guided view'),
      );
      const toBench = (run) => {
        carry = { to: 'bench', run };
        ctx.navigate(ASK_HREF.bench);
      };
      current.mount(el, { ...ctx, carry: handed, toBench });
    },
    unmount() {
      current?.unmount();
      slot?.replaceChildren();
      current = null;
    },
  };
}

function themeToggle() {
  const button = h('button', { type: 'button', class: 'oc-btn oc-btn--icon oc-theme-toggle ms-wide-only' }, icon('monitor'), icon('sun'), icon('moon'));
  const show = (current) => {
    const next = THEME_LABELS[nextTheme(current)];
    button.dataset.ocValue = current;
    button.dataset.ocTip = next;
    button.setAttribute('aria-label', next);
  };
  show(storedTheme());
  button.addEventListener('click', () => {
    show(applyTheme(nextTheme(button.dataset.ocValue)));
    syncThemeColor();
  });
  return button;
}

function textSizeToggle() {
  const button = h(
    'button',
    { type: 'button', class: 'oc-btn oc-btn--icon ms-wide-only', 'aria-label': 'Compact text', 'data-oc-tip': 'Compact text' },
    icon('text-size'),
  );
  const show = (size) => button.setAttribute('aria-pressed', String(size === 'compact'));
  show(storedTextSize());
  button.addEventListener('click', () => {
    show(applyTextSize(button.getAttribute('aria-pressed') === 'true' ? 'default' : 'compact'));
  });
  return button;
}

// The browser chrome follows --theme-color from the tokens.
function syncThemeColor() {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = h('meta', { name: 'theme-color' });
    document.head.append(meta);
  }
  meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim());
}

function navLinks(withIcons) {
  return DESTINATIONS.map((d) =>
    h('a', { href: hrefOf(d.view), 'data-view': d.view }, withIcons ? icon(d.icon, 'tab') : null, h('span', {}, d.label)),
  );
}

// services: { mode, client, store }, handed to every view with the route and navigate.
export function mountShell(shell, services = {}) {
  const modeSwitch = h('div', { class: 'oc-topbar__slot', id: 'mode-switch' });
  const topnav = h('nav', { class: 'oc-topnav', 'aria-label': 'Main' }, navLinks(false));
  const tabbar = h('nav', { class: 'oc-tabbar', 'aria-label': 'Main' }, navLinks(true));
  const main = h('main', { class: 'oc-main', id: 'main' });
  shell.append(
    h('header', { class: 'oc-topbar' },
      h('span', { class: 'oc-topbar__title' }, 'magicshell'),
      topnav,
      h('div', { class: 'oc-topbar__end' }, modeSwitch, themeToggle(), textSizeToggle()),
    ),
    main,
    tabbar,
  );

  let current = null;
  let first = true;
  const navigate = (hash) => {
    if (location.hash === hash) show();
    else location.hash = hash;
  };
  const show = () => {
    const r = route(location.hash);
    current?.unmount();
    for (const a of [...topnav.children, ...tabbar.children]) {
      if (a.dataset.view === r.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    document.title = r.view === 'ask' ? (isBench(r) ? 'Bench · magicshell' : 'magicshell') : `${TITLES[r.view]} · magicshell`;
    const el = h('div', { class: 'oc-columns', 'data-view': r.view });
    main.replaceChildren(el);
    current = viewFor(r.view);
    current.mount(el, { ...services, route: r, navigate, notify, modeSwitch });
    if (!first) {
      window.scrollTo(0, 0);
      el.querySelector('h1')?.focus({ preventScroll: true });
    }
    first = false;
  };
  window.addEventListener('hashchange', show);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
  syncThemeColor();
  show();
}

function localStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The endpoint a visitor keeps in this browser (mode 1); Settings writes it.
function byok(storage) {
  try {
    const v = JSON.parse(storage?.getItem('magicshell.byok') ?? 'null');
    if (v && typeof v.endpoint === 'string' && v.endpoint && typeof v.model === 'string' && v.model) {
      return { endpoint: v.endpoint, model: v.model, key: typeof v.key === 'string' ? v.key : '' };
    }
  } catch {
    // Unreadable settings count as none.
  }
  return null;
}

const NO_ENDPOINT = { run: async () => { throw new RunError('Add your model endpoint in Settings.', 'validation'); } };
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
};

// Learns the mode and wires the client and store for it. Task 17 adds settings and sign-in.
async function boot(shell) {
  const fetchFn = (...args) => fetch(...args);
  if (!window.isSecureContext || !navigator.clipboard) document.documentElement.dataset.ocNoCopy = '';
  const { mode } = await detectMode(fetchFn);
  const storage = localStore();
  let client;
  let store;
  if (mode === 'pages') {
    const config = byok(storage);
    client = config ? createDirectClient(config, fetchFn) : NO_ENDPOINT;
    store = createBrowserStore(storage ?? memoryStorage());
  } else {
    client = createServerClient(fetchFn);
    store = mode === 'accounts' ? createServerStore(fetchFn) : createBrowserStore(storage ?? memoryStorage());
  }
  registerView('ask', createAskView());
  registerView('history', createHistoryView());
  registerView('setups', createSetupsView());
  mountShell(shell, { mode, client, store });
}

if (typeof document !== 'undefined') {
  const shell = document.getElementById('shell');
  if (shell) boot(shell);
}
