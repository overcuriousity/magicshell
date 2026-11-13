// Lucide icons (ISC, see THIRD-PARTY-LICENSES), from the manifest's oc-kit/assets/icons where it has them.
// One icon per meaning; the name is the meaning, not the Lucide name.
const SVG_NS = 'http://www.w3.org/2000/svg';

const p = (d) => ['path', { d }];
const PATHS = {
  // Lucide circle-help (the manifest has no icon for asking)
  ask: [['circle', { cx: 12, cy: 12, r: 10 }], p('M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'), p('M12 17h.01')],
  history: [p('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'), p('M3 3v5h5'), p('M12 7v5l4 2')],
  // Lucide list
  setups: [p('M3 5h.01'), p('M3 12h.01'), p('M3 19h.01'), p('M8 5h13'), p('M8 12h13'), p('M8 19h13')],
  settings: [
    p('M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915'),
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    p('M12 2v2'), p('M12 20v2'), p('m4.93 4.93 1.41 1.41'), p('m17.66 17.66 1.41 1.41'),
    p('M2 12h2'), p('M20 12h2'), p('m6.34 17.66-1.41 1.41'), p('m19.07 4.93-1.41 1.41'),
  ],
  moon: [p('M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401')],
  monitor: [
    ['rect', { width: 20, height: 14, x: 2, y: 3, rx: 2 }],
    ['line', { x1: 8, x2: 16, y1: 21, y2: 21 }],
    ['line', { x1: 12, x2: 12, y1: 17, y2: 21 }],
  ],
  // Lucide a-large-small
  'text-size': [p('m15 16 2.536-7.328a1.02 1.02 1 0 1 1.928 0L22 16'), p('M15.697 14h5.606'), p('m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16'), p('M3.304 13h6.392')],
  check: [p('M20 6 9 17l-5-5')],
  // Lucide triangle-alert
  warning: [p('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'), p('M12 9v4'), p('M12 17h.01')],
  // Lucide circle-check, circle-x, info: the status symbols of notices
  success: [['circle', { cx: 12, cy: 12, r: 10 }], p('m16 9-5.5 5.5L8 12')],
  danger: [['circle', { cx: 12, cy: 12, r: 10 }], p('m15 9-6 6'), p('m9 9 6 6')],
  info: [['circle', { cx: 12, cy: 12, r: 10 }], p('M12 16v-4'), p('M12 8h.01')],
  plus: [p('M5 12h14'), p('M12 5v14')],
  x: [p('M18 6 6 18'), p('m6 6 12 12')],
  copy: [['rect', { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }], p('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')],
  // Lucide trash-2
  trash: [p('M10 11v6'), p('M14 11v6'), p('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'), p('M3 6h18'), p('M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2')],
  pencil: [p('M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'), p('m15 5 4 4')],
  'chevron-down': [p('m6 9 6 6 6-6')],
  // Lucide chevron-up (not in the manifest)
  'chevron-up': [p('m18 15-6-6-6 6')],
  // Lucide undo-2
  undo: [p('M9 14 4 9l5-5'), p('M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11')],
  download: [p('M12 15V3'), p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m7 10 5 5 5-5')],
  // Lucide upload (not in the manifest)
  upload: [p('M12 3v12'), p('m17 8-5-5-5 5'), p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4')],
};

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// size: 'tool' (16 px, default), 'row' (14 px) or 'tab' (20 px).
export function icon(name, size = 'tool') {
  const parts = PATHS[name];
  if (!parts) throw new Error(`no icon named ${name}`);
  const cls = size === 'tool' ? 'oc-icon' : `oc-icon oc-icon--${size}`;
  const svg = svgEl('svg', {
    class: cls,
    'data-icon': name,
    'aria-hidden': 'true',
    focusable: 'false',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  for (const [tag, attrs] of parts) svg.append(svgEl(tag, attrs));
  return svg;
}
