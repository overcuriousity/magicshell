// The app shell: top bar, navigation (top from 48rem, tab bar below), and the view of the current route.
// Views register as { mount(el, ctx), unmount() }; a destination without one shows its heading.
// Boot learns the mode and wires client and store for it; accounts mode shows only Sign in until
// someone is signed in.
import { applyByok, loadByok } from './byok.js';
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
import { createSettingsView, LOOK_EVENT, NOT_SAVING } from './views/settings.js';
import { createSetupsView } from './views/setups.js';
import { createSignInView } from './views/sign-in.js';

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

// Pages mode before an endpoint is saved: one line pointing to Settings, in place of the guide.
function needsEndpoint() {
  return {
    mount(el) {
      el.append(
        h('header', { class: 'oc-page-head' }, h('h1', { class: 'oc-text-page', tabindex: '-1' }, 'Ask')),
        h('p', { class: 'ms-empty' }, 'Add your model endpoint in ', h('a', { href: '#/settings' }, 'Settings'), '.'),
      );
    },
    unmount() {},
    currentRun: () => null,
  };
}

export function createAskView({ guided = createGuidedView(), bench = createBenchView(), missing = needsEndpoint() } = {}) {
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
      current = side === 'bench' ? bench : ctx.needsEndpoint ? missing : guided;
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
    applyTheme(nextTheme(button.dataset.ocValue));
    window.dispatchEvent(new CustomEvent(LOOK_EVENT));
  });
  window.addEventListener(LOOK_EVENT, () => {
    show(storedTheme());
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
    applyTextSize(button.getAttribute('aria-pressed') === 'true' ? 'default' : 'compact');
    window.dispatchEvent(new CustomEvent(LOOK_EVENT));
  });
  window.addEventListener(LOOK_EVENT, () => show(storedTextSize()));
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

// services: { mode, client, store, user, ... }, handed to every view with the route and navigate.
// It is read at every route change, so boot can swap the client or the user in place.
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
  // The route to return to after signing in.
  let asked = '#/ask';
  const navigate = (hash) => {
    // Views send the app here when the server refused the session: whoever it was is signed out.
    if (services.mode === 'accounts' && route(hash).view === 'sign-in') services.user = null;
    if (location.hash === hash) show();
    else location.hash = hash;
  };
  const show = () => {
    let r = route(location.hash);
    const accounts = services.mode === 'accounts';
    if (r.view === 'sign-in' && !accounts) r = redirect('#/ask');
    else if (r.view === 'sign-in' && services.user) r = redirect(asked);
    else if (accounts && r.view !== 'sign-in') {
      asked = location.hash || '#/ask';
      if (!services.user) r = redirect('#/sign-in');
    }
    const locked = accounts && (r.view === 'sign-in' || !services.user);
    topnav.hidden = locked;
    tabbar.hidden = locked;
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
  // Changes the address without a hashchange, so the view shown is the one returned.
  const redirect = (hash) => {
    history.replaceState(null, '', hash);
    return route(hash);
  };
  window.addEventListener('hashchange', show);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
  syncThemeColor();
  show();
  return { navigate, asked: () => asked };
}

// localStorage when it can keep something; null when it is missing or refuses writes.
function localStore() {
  try {
    const storage = window.localStorage;
    storage.setItem('magicshell.probe', '1');
    storage.removeItem('magicshell.probe');
    return storage;
  } catch {
    return null;
  }
}

const NO_ENDPOINT = { run: async () => { throw new RunError('Add your model endpoint in Settings.', 'validation'); } };
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
// The start notice: only where history lives in this browser (pages and open mode).
export const showsNotSaving = ({ mode, storage, store }) => mode !== 'accounts' && (!storage || store.persistent === false);

const NO_COOKIE = 'This browser did not keep the sign-in. Open the app over https or localhost.';
const ENTERED = ['magicshell.bench', 'magicshell.guided'];

// Learns the mode and wires the client and store for it; Settings and Sign in change them in place.
async function boot(shell) {
  const fetchFn = (...args) => fetch(...args);
  if (!window.isSecureContext || !navigator.clipboard) document.documentElement.dataset.ocNoCopy = '';
  const config = await detectMode(fetchFn);
  const { mode } = config;
  const storage = localStore();
  const kept = storage ?? memoryStorage();
  const services = { mode, model: config.model, user: config.user };
  let shellApi = null;
  const navigate = (hash) => shellApi.navigate(hash);

  // Accounts mode: a session that ran out during use leads to Sign in, whichever view noticed.
  const signInOnAuth = (store) => {
    const wrapped = { persistent: true };
    for (const [name, fn] of Object.entries(store)) {
      if (typeof fn !== 'function') continue;
      wrapped[name] = (...args) => Promise.resolve().then(() => fn(...args)).catch((e) => {
        if (e instanceof RunError && e.kind === 'auth' && route(location.hash).view !== 'sign-in') navigate('#/sign-in');
        throw e;
      });
    }
    return wrapped;
  };
  // A fresh store per user, so nothing one user loaded is shown to the next.
  const userChanged = async () => {
    const now = await detectMode(fetchFn);
    services.user = now.mode === 'accounts' ? now.user : null;
    services.store = signInOnAuth(createServerStore(fetchFn));
  };

  if (mode === 'pages') {
    const useByok = (values) => {
      services.byok = values;
      services.needsEndpoint = !values;
      services.client = values ? createDirectClient(values, fetchFn) : NO_ENDPOINT;
    };
    useByok(loadByok(kept));
    services.store = createBrowserStore(kept);
    services.currentByok = () => services.byok;
    // { error } or { kept }; the new values are used either way, kept or not.
    services.saveByok = (values) => {
      const result = applyByok(storage, values);
      if (result.error) return { error: result.error };
      useByok(result.value);
      return { kept: result.kept };
    };
  } else {
    services.client = createServerClient(fetchFn);
    services.store = mode === 'accounts' ? signInOnAuth(createServerStore(fetchFn)) : createBrowserStore(kept);
  }
  if (mode === 'accounts') {
    services.signIn = async (username, password) => {
      await services.client.signIn(username, password);
      await userChanged();
      if (!services.user) throw new RunError(NO_COOKIE, 'auth');
      navigate(shellApi.asked());
    };
    services.signOut = async () => {
      await services.client.signOut();
      for (const key of ENTERED) {
        try {
          sessionStorage.removeItem(key);
        } catch {
          // Nothing kept to clear.
        }
      }
      await userChanged();
      // Whoever signs in next starts at Ask.
      navigate('#/ask');
    };
  }

  registerView('ask', createAskView());
  registerView('history', createHistoryView());
  registerView('setups', createSetupsView());
  registerView('settings', createSettingsView());
  registerView('sign-in', createSignInView());
  shellApi = mountShell(shell, services);
  if (showsNotSaving({ mode, storage, store: services.store })) notify(NOT_SAVING, { kind: 'warning', ms: 12000 });
}

if (typeof document !== 'undefined') {
  const shell = document.getElementById('shell');
  if (shell) boot(shell);
}
