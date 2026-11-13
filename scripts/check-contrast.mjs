#!/usr/bin/env node
// Checks the colour pairs the app relies on, in both themes, against web/css/00-tokens.css:
// the manifest's documented text pairs, primary text on every option and level soft fill (7:1),
// and every chip edge, bar colour and level colour on the page (3:1). A bar colour under 3:1 passes
// only if web/css/40-app.css gives it the --color-border-control outline in that theme: an outline is one
// declaration on :root, either a value for both themes or light-dark(light, dark), which follows the
// color-scheme both dark token blocks set. Dark blocks in 40-app.css, if any come back, must agree.
// Exits 1 naming each failure.
// Usage: node scripts/check-contrast.mjs [web/css]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web', 'css');
const tokensCss = fs.readFileSync(path.join(dir, '00-tokens.css'), 'utf8');
const appCss = fs.readFileSync(path.join(dir, '40-app.css'), 'utf8');

// The mixes 40-app.css declares; the check fails if the file says something else.
const SOFT = { share: 0.12, into: '--color-bg-elevated', css: '--k-soft: color-mix(in srgb, var(--k) 12%, var(--color-bg-elevated));' };
const EDGE = { share: 0.45, into: '--color-fg-primary', css: '--k-edge: color-mix(in srgb, var(--k) 45%, var(--color-fg-primary));' };
const OUTLINE = '--color-border-control';

const KEYS = [
  ...Array.from({ length: 8 }, (_, i) => [`opt-${i + 1}`, `--chart-cat-${i + 1}`]),
  ...Array.from({ length: 4 }, (_, i) => [`lvl-${i + 1}`, `--chart-seq-${i + 1}`]),
  ['ms-accent', '--color-accent'],
  ['ms-neutral', '--color-fg-muted'],
];

function blockAfter(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function declarations(block, valueRe) {
  const out = {};
  for (const m of (block ?? '').matchAll(new RegExp(`(--[\\w-]+):\\s*(${valueRe.source})\\s*;`, 'g'))) out[m[1]] = m[2];
  return out;
}

const HEX = /#[0-9a-fA-F]{6}\b/;
const DARK_MEDIA = ':root:not([data-theme="light"])';
const DARK_ATTR = ':root[data-theme="dark"]';

function themes(css, valueRe) {
  const light = declarations(blockAfter(css, ':root {'), valueRe);
  const media = declarations(blockAfter(css, DARK_MEDIA), valueRe);
  const attr = declarations(blockAfter(css, DARK_ATTR), valueRe);
  return { light, dark: { ...light, ...attr }, media, attr };
}

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (c) => {
  const [r, g, b] = c.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// color-mix(in srgb, a share, b): a straight mix of the encoded channels.
const mix = (a, share, b) => a.map((v, i) => v * share + b[i] * (1 - share));

const errors = [];
const notes = [];

const tok = themes(tokensCss, HEX);
for (const k of new Set([...Object.keys(tok.media), ...Object.keys(tok.attr)])) {
  if (tok.media[k] !== tok.attr[k]) errors.push(`tokens: the two dark blocks differ at ${k}`);
}
for (const rule of [SOFT, EDGE]) {
  if (!appCss.includes(rule.css)) errors.push(`40-app.css: expected "${rule.css}"`);
}

// light-dark() in the outlines resolves by color-scheme, so each theme's token block must set it.
for (const [name, selector, scheme] of [['light', ':root {', 'light'], ['dark (media)', DARK_MEDIA, 'dark'], ['dark (data-theme)', DARK_ATTR, 'dark']]) {
  if (!new RegExp(`color-scheme:\\s*${scheme}\\s*;`).test(blockAfter(tokensCss, selector) ?? '')) {
    errors.push(`tokens: the ${name} block must set color-scheme: ${scheme}`);
  }
}

const COLOR = /var\(--[\w-]+\)|transparent/;
const outlines = { light: {}, dark: {} };
const outlineRe = new RegExp(`(--outline-[\\w-]+):\\s*(?:light-dark\\(\\s*(${COLOR.source})\\s*,\\s*(${COLOR.source})\\s*\\)|(${COLOR.source}))\\s*;`, 'g');
for (const m of (blockAfter(appCss, ':root {') ?? '').matchAll(outlineRe)) {
  outlines.light[m[1]] = m[2] ?? m[4];
  outlines.dark[m[1]] = m[3] ?? m[4];
}
const appDark = themes(appCss, COLOR);
for (const k of new Set([...Object.keys(appDark.media), ...Object.keys(appDark.attr)])) {
  if (appDark.media[k] !== appDark.attr[k]) errors.push(`40-app.css: the two dark blocks differ at ${k}`);
  else outlines.dark[k] = appDark.attr[k];
}

for (const name of ['light', 'dark']) {
  const t = tok[name];
  const c = (token) => {
    if (!t[token]) throw new Error(`${name}: ${token} is not defined in 00-tokens.css`);
    return channels(t[token]);
  };
  const need = (label, fg, bg, floor) => {
    const ratio = contrast(fg, bg);
    if (ratio < floor) errors.push(`${name}: ${label} is ${ratio.toFixed(2)}, needs ${floor}`);
    return ratio;
  };

  // The manifest's documented pairs (oc-kit tests/contrast.rs).
  for (const bg of ['bg-base', 'bg-surface', 'bg-elevated']) {
    need(`fg-primary on ${bg}`, c('--color-fg-primary'), c(`--color-${bg}`), 7);
    for (const fg of ['fg-secondary', 'fg-muted', 'accent', 'danger', 'warning', 'success']) {
      need(`${fg} on ${bg}`, c(`--color-${fg}`), c(`--color-${bg}`), 4.5);
    }
    need(`border-control on ${bg}`, c('--color-border-control'), c(`--color-${bg}`), 3);
  }
  need('accent-fg on accent', c('--color-accent-fg'), c('--color-accent'), 4.5);
  for (const bg of ['bg-hover', 'bg-active']) need(`fg-secondary on ${bg}`, c('--color-fg-secondary'), c(`--color-${bg}`), 4.5);
  for (const token of ['--color-bg-base', '--color-bg-surface', '--color-fg-primary']) {
    const l = luminance(c(token));
    if (l < 1e-9 || l > 1 - 1e-9) errors.push(`${name}: ${token} is pure black or white`);
  }

  const base = c('--color-bg-base');
  const outlined = [];
  for (const [cls, token] of KEYS) {
    const k = c(token);
    const soft = mix(k, SOFT.share, c(SOFT.into));
    const edge = mix(k, EDGE.share, c(EDGE.into));
    need(`fg-primary on the ${cls} soft fill`, c('--color-fg-primary'), soft, 7);
    need(`the ${cls} edge on bg-base`, edge, base, 3);
    need(`the ${cls} edge on its soft fill`, edge, soft, 3);
    if (cls === 'ms-accent') {
      need('the meter (accent) on bg-base', k, base, 3);
      continue;
    }
    if (cls === 'ms-neutral') continue;
    const ratio = contrast(k, base);
    const hasOutline = outlines[name][`--outline-${cls}`] === `var(${OUTLINE})`;
    if (ratio < 3 && !hasOutline) errors.push(`${name}: the ${cls} bar (${token}) on bg-base is ${ratio.toFixed(2)}, needs 3 or an outline`);
    if (ratio >= 3 && hasOutline) errors.push(`${name}: the ${cls} bar is ${ratio.toFixed(2)} on bg-base and needs no outline`);
    if (hasOutline) outlined.push(`${cls} ${ratio.toFixed(2)}`);
  }
  need('the bar outline (border-control) on bg-base', c(OUTLINE), base, 3);
  notes.push(`${name}: outlined bars: ${outlined.join(', ') || 'none'}`);
}

for (const n of notes) console.log(n);
for (const e of errors) console.error(e);
process.exit(errors.length ? 1 : 0);
