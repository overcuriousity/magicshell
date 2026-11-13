// The app shell: top bar, navigation (top from 48rem, tab bar below), and the view of the current route.
// Views register as { mount(el, ctx), unmount() }, one for each destination.
// Boot learns the mode and wires client and store for it; accounts mode shows only Sign in until
// someone is signed in.
import { createServerClient } from './client-server.js';
import { detectMode } from './mode.js';
import { HREF, hrefOf } from './routes.js';
import { RunError } from './run-error.js';
import { createBrowserStore } from './store-browser.js';
import { createServerStore } from './store-server.js';
import { h } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { notify } from './ui/notice.js';
import { applyTextSize, applyTheme, nextTheme, storedTextSize, storedTheme, THEME_LABELS } from './ui/theme.js';
import { queueRun, takeRun } from './views/bench-model.js';
import { createBenchView } from './views/bench.js';
import { queueGuidedRun, takeGuidedRun } from './views/guided-model.js';
import { createGuidedView } from './views/guided.js';
import { createHistoryView } from './views/history.js';
import { createSettingsView, LOOK_EVENT, NOT_SAVING } from './views/settings.js';
import { createSetupsView } from './views/setups.js';
import { forget, sessionStore } from './views/session.js';
import { createSignInView } from './views/sign-in.js';

const DESTINATIONS = [
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

export { hrefOf };

const registry = new Map();
function registerView(name, view) {
  registry.set(name, view);
}
const viewFor = (name) => registry.get(name);

// Ask: the guided view at #/ask (and on every fresh load), the bench at #/ask/bench. The switch
// in the top bar carries what was entered over; "something else" in the guide opens the bench as
// it was left.
const isBench = (r) => r.view === 'ask' && r.id === 'bench';
const ASK_HREF = { guided: HREF.ask, bench: HREF.bench };

// What the switch hands over goes through the in-memory queues of each side (bench-model.js and
// guided-model.js), as every other hand-over does. A side with nothing entered hands over nothing,
// so the other keeps its own draft.
export function createAskView({
  guided = createGuidedView(),
  bench = createBenchView(),
  hand = { bench: (run) => queueRun(run), guided: queueGuidedRun },
} = {}) {
  let current = null;
  let slot = null;
  return {
    mount(el, ctx) {
      const side = isBench(ctx.route) ? 'bench' : 'guided';
      const other = side === 'bench' ? 'guided' : 'bench';
      current = side === 'bench' ? bench : guided;
      slot = ctx.modeSwitch ?? null;
      slot?.replaceChildren(
        h('a', { href: ASK_HREF[other], class: 'ms-switch', onclick: (e) => {
          // A plain primary click only: a modifier-click opens a new tab and must leave nothing behind.
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          const run = current.currentRun();
          if (run) hand[other](run);
        } },
          other === 'bench' ? 'Bench' : 'Guided view'),
      );
      const toBench = () => ctx.navigate(ASK_HREF.bench);
      current.mount(el, { ...ctx, toBench });
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
  // The name stays "Compact text" (aria-pressed says whether it is on); the tooltip says it in words.
  const show = (size) => {
    button.setAttribute('aria-pressed', String(size === 'compact'));
    button.dataset.ocTip = size === 'compact' ? 'Compact text: on' : 'Compact text: off';
  };
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
function mountShell(shell, services = {}) {
  const modeSwitch = h('div', { class: 'oc-topbar__slot', id: 'mode-switch' });
  const topnav = h('nav', { class: 'oc-topnav', 'aria-label': 'Main' }, navLinks(false));
  const tabbar = h('nav', { class: 'oc-tabbar', 'aria-label': 'Main' }, navLinks(true));
  const main = h('main', { class: 'oc-main', id: 'main' });
  // One quiet line at the end of every page, as in bitvault: the app and its version.
  const footer = services.version ? h('footer', { class: 'ms-footer' }, `magicshell ${services.version}`) : null;
  shell.append(
    h('header', { class: 'oc-topbar' },
      h('a', { class: 'oc-topbar__title', href: HREF.ask, 'data-fid': 'home', onclick: (e) => {
        // A modifier-click opens a new tab and must leave this one as it is.
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        startOver();
      } }, 'magicshell'),
      topnav,
      h('div', { class: 'oc-topbar__end' }, modeSwitch, themeToggle(), textSizeToggle()),
    ),
    main,
    tabbar,
  );

  let current = null;
  let first = true;
  // The route to return to after signing in.
  let asked = HREF.ask;
  const navigate = (hash) => {
    // Views send the app here when the server refused the session: whoever it was is signed out.
    if (services.mode === 'accounts' && route(hash).view === 'sign-in') services.user = null;
    if (location.hash === hash) show();
    else location.hash = hash;
  };
  const show = () => {
    let r = route(location.hash);
    const accounts = services.mode === 'accounts';
    if (r.view === 'sign-in' && !accounts) r = redirect(HREF.ask);
    else if (r.view === 'sign-in' && services.user) r = redirect(asked);
    else if (accounts && r.view !== 'sign-in') {
      asked = location.hash || HREF.ask;
      if (!services.user) r = redirect(HREF.signIn);
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
    main.replaceChildren(...[el, footer].filter(Boolean));
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
  // The title starts over: the drafts of the guide and the bench, and any run waiting for them,
  // go, and the guide opens at step 1. History and setups stay. Undo puts the drafts back.
  const startOver = () => {
    const from = location.hash || HREF.ask;
    const kept = ENTERED.map((key) => [key, sessionStore().getItem(key)]).filter(([, value]) => value !== null);
    forget(ENTERED);
    takeRun();
    takeGuidedRun();
    navigate(HREF.ask);
    if (kept.length === 0) return;
    notify(STARTED_OVER, {
      action: {
        label: 'Undo',
        run: () => {
          for (const [key, value] of kept) {
            try {
              sessionStore().setItem(key, value);
            } catch {
              // Nothing to put back into.
            }
          }
          navigate(from);
        },
      },
    });
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

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
// The start notice: only where history lives in this browser (open mode).
export const showsNotSaving = ({ mode, storage, store }) => mode !== 'accounts' && (!storage || store.persistent === false);

export const trimmedSentence = (n) =>
  `This browser is out of room, so History removed its ${n === 1 ? 'oldest entry' : `${n} oldest entries`}. It keeps making room this way.`;

const STARTED_OVER = 'Started over. What you entered is cleared.';
const NO_COOKIE = 'This browser did not keep the sign-in. Open the app over https or localhost.';
const ENTERED = ['magicshell.bench', 'magicshell.guided'];
const NO_SERVER = 'This app needs its magicshell server. Start it and reload the page.';

// What every view gets from the server's config; Why? exists in accounts mode only.
export function servicesFor(config) {
  const { mode } = config;
  return { mode, model: config.model, user: config.user, version: config.version, why: mode === 'accounts' ? config.why : null };
}

// Learns the mode and wires the client and store for it; Sign in changes them in place. Without
// its server the app shows one line and nothing else.
async function boot(shell) {
  const fetchFn = (...args) => fetch(...args);
  if (!window.isSecureContext || !navigator.clipboard) document.documentElement.dataset.ocNoCopy = '';
  const config = await detectMode(fetchFn);
  const { mode } = config;
  if (!mode) {
    shell.append(h('main', { class: 'oc-main', id: 'main' }, h('p', { class: 'ms-empty' }, NO_SERVER)));
    return;
  }
  const storage = localStore();
  const kept = storage ?? memoryStorage();
  const services = servicesFor(config);
  let shellApi = null;
  // The not-saving notice, once per page: at boot, or when storage stops taking writes later.
  let warned = false;
  const warnNotSaving = () => {
    if (warned) return;
    warned = true;
    notify(NOT_SAVING, { kind: 'warning', ms: 12000 });
  };
  // History making room in a full browser, said once per page with how many entries went.
  let trimmedOnce = false;
  const warnTrimmed = (n) => {
    if (trimmedOnce) return;
    trimmedOnce = true;
    notify(trimmedSentence(n), { kind: 'warning', ms: 12000 });
  };
  const browserStore = () => createBrowserStore(kept, { onNotSaving: warnNotSaving, onTrimmed: warnTrimmed });
  const navigate = (hash) => shellApi.navigate(hash);

  // Accounts mode: a session that ran out during use leads to Sign in, whichever view noticed.
  const signInOnAuth = (store) => {
    const wrapped = { persistent: true };
    for (const [name, fn] of Object.entries(store)) {
      if (typeof fn !== 'function') continue;
      wrapped[name] = (...args) => Promise.resolve().then(() => fn(...args)).catch((e) => {
        if (e instanceof RunError && e.kind === 'auth' && route(location.hash).view !== 'sign-in') navigate(HREF.signIn);
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

  services.client = createServerClient(fetchFn);
  services.store = mode === 'accounts' ? signInOnAuth(createServerStore(fetchFn)) : browserStore();
  if (mode === 'accounts') {
    services.signIn = async (username, password) => {
      await services.client.signIn(username, password);
      await userChanged();
      if (!services.user) throw new RunError(NO_COOKIE, 'auth');
      navigate(shellApi.asked());
    };
    services.signOut = async () => {
      await services.client.signOut();
      // Nothing one user entered or handed over stays for the next.
      forget(ENTERED);
      takeRun();
      takeGuidedRun();
      await userChanged();
      // Whoever signs in next starts at Ask.
      navigate(HREF.ask);
    };
  }

  registerView('ask', createAskView());
  registerView('history', createHistoryView());
  registerView('setups', createSetupsView());
  registerView('settings', createSettingsView());
  registerView('sign-in', createSignInView());
  shellApi = mountShell(shell, services);
  if (showsNotSaving({ mode, storage, store: services.store })) warnNotSaving();
}

if (typeof document !== 'undefined') {
  const shell = document.getElementById('shell');
  if (shell) boot(shell);
}
