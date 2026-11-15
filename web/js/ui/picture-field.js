// The pictures of a situation: thumbnails with a remove button each, a button that opens the
// device's own picker, on touch screens one that opens the camera, and a line with the count and
// size. Dropping files on the situation and pasting a picture into it add pictures too.
import { addFiles, browserCodec, kilobytes, picturesLine } from '../pictures.js';
import { h } from './dom.js';
import { icon } from './icons.js';

export const addLabel = (count) => (count === 0 ? 'Add picture' : 'Add another');
export const isFull = (pictures, max) => pictures.length >= max;
export const added = (n, total) => (n <= 0 ? '' : n === 1 ? `Picture ${total} added.` : `${n} pictures added.`);
export const removed = (position) => `Picture ${position} removed.`;
export const busyNote = (count) => (count <= 0 ? '' : count === 1 ? 'Reading the picture…' : 'Reading the pictures…');
export const sizeLabel = (p) => `${p.width}×${p.height} · ${kilobytes(p.bytes)}`;

// The image files of a paste or a drop.
export const imageFiles = (transfer) => [...(transfer?.files ?? [])].filter((f) => typeof f.type === 'string' && f.type.startsWith('image/'));
// The pictures of a paste. A paste that also has text is text: a spreadsheet copies its cells as
// text and as a rendering of them, and the rendering is not what was meant.
export const pastedPictures = (clipboard) => ([...(clipboard?.types ?? [])].includes('text/plain') ? [] : imageFiles(clipboard));
export const carriesFiles = (transfer) => [...(transfer?.types ?? [])].includes('Files');

// A file dropped beside the situation would open in the tab in place of the app, and the pictures
// already added would be gone. The situation's own handler takes the drops meant for it first.
export function guardStrayDrops(target) {
  for (const type of ['dragover', 'drop']) {
    target.addEventListener(type, (e) => {
      if (carriesFiles(e.dataTransfer)) e.preventDefault();
    });
  }
}

const FULL = 'That is the most this server takes.';

// Read-only thumbnails, for results and History: `parts` are pictures or an entry's kept parts
// (a part without a preview shows the picture symbol). With `sizes`, each has its size beside it.
export function thumbs(parts, { sizes = false, small = false } = {}) {
  if (!parts || parts.length === 0) return null;
  return h('ul', { class: small ? 'ms-thumbs ms-thumbs--small' : 'ms-thumbs' },
    parts.map((p, i) => {
      // The picture itself where it is held (sharper); History has the preview only.
      const src = p.url ?? p.preview ?? null;
      const label = `Picture ${i + 1}`;
      const image = src
        ? h('img', { class: 'ms-thumb', src, alt: label, width: '44', height: '44' })
        : h('span', { class: 'ms-thumb ms-thumb--none', role: 'img', 'aria-label': label }, icon('picture'));
      return h('li', {}, image, sizes ? h('span', { class: 'ms-thumbs__size' }, sizeLabel(p)) : null);
    }));
}

// get(): the pictures held now; set(list): the new list; limits: { max, edge } from the server;
// notify(text, opts) for problems; announce(text) for screen readers; id prefixes the data-fids.
export function createPictureField({ get, set, limits, notify, announce = () => {}, codec = browserCodec(), id }) {
  // Adds wait for each other: a second paste while the first picture is still being shrunk is
  // added after it, not dropped.
  let queue = Promise.resolve();

  // Adds what fits and says what did not. `set` rebuilds the form, so nothing here is kept.
  async function addNow(files) {
    const before = get();
    const { pictures, problems } = await addFiles(files, before, { max: limits.max, edge: limits.edge, uid: () => crypto.randomUUID(), ...codec });
    const fresh = pictures.slice(before.length);
    if (fresh.length > 0) {
      // Onto what is held now: a picture removed while these were shrunk stays removed.
      const merged = [...get(), ...fresh];
      set(merged);
      announce(added(fresh.length, merged.length));
    }
    for (const text of problems) notify?.(text, { kind: 'warning' });
  }

  function add(files) {
    if (files.length === 0) return queue;
    queue = queue.then(() => addNow(files)).catch(() => {});
    return queue;
  }

  function remove(index) {
    set(get().filter((_, i) => i !== index));
    announce(removed(index + 1));
  }

  function element() {
    const pictures = get();
    const full = isFull(pictures, limits.max);
    const fileInput = (attrs) => h('input', {
      type: 'file',
      accept: 'image/*',
      hidden: true,
      tabindex: '-1',
      'aria-hidden': 'true',
      ...attrs,
      onchange: (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        add(files);
      },
    });
    const opener = (input, cls, fid, content) => h('button', {
      type: 'button',
      class: cls,
      'data-fid': fid,
      'aria-disabled': full ? 'true' : null,
      onclick: () => {
        if (!isFull(get(), limits.max)) input.click();
      },
    }, ...content);
    const input = fileInput({ multiple: limits.max > 1 });
    // Phone browsers may leave the camera out of a picker that takes several files; `capture` opens it.
    const cameraInput = fileInput({ capture: 'environment' });
    const button = opener(input, 'oc-btn', `${id}:add`, [icon('plus'), addLabel(pictures.length)]);
    const camera = opener(cameraInput, 'oc-btn ms-pictures__camera', `${id}:camera`, [icon('camera'), 'Take photo']);
    const line = picturesLine(pictures, limits.max);
    return h('div', { class: 'ms-pictures' },
      pictures.length > 0
        ? h('ul', { class: 'ms-pictures__list' },
            pictures.map((p, i) =>
              h('li', { class: 'ms-picture' },
                h('img', { class: 'ms-picture__img', src: p.url, alt: `Picture ${i + 1}`, width: '76', height: '76' }),
                h('button', {
                  type: 'button',
                  class: 'oc-btn oc-btn--icon ms-picture__remove',
                  'aria-label': `Remove picture ${i + 1}`,
                  'data-oc-tip': `Remove picture ${i + 1}`,
                  'data-fid': `${id}:remove:${i}`,
                  onclick: () => remove(i),
                }, icon('x')),
              )))
        : null,
      h('div', { class: 'ms-pictures__add' },
        full ? null : h('span', { class: 'ms-pictures__hint' }, 'Drop pictures here, paste one, or'),
        camera,
        button,
        input,
        cameraInput,
      ),
      line ? h('p', { class: 'ms-pictures__line' }, full ? `${line} · ${FULL}` : line) : null,
    );
  }

  // Dropping files on `zone` and pasting a picture into it add pictures. Text pastes and drags
  // that carry no files are left to the browser.
  function attach(zone) {
    let depth = 0;
    const over = (on) => zone.classList.toggle('is-over', on);
    zone.addEventListener('dragenter', (e) => {
      if (!carriesFiles(e.dataTransfer)) return;
      depth += 1;
      over(true);
    });
    zone.addEventListener('dragleave', (e) => {
      if (!carriesFiles(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) over(false);
    });
    zone.addEventListener('dragover', (e) => {
      if (carriesFiles(e.dataTransfer)) e.preventDefault();
    });
    zone.addEventListener('drop', (e) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      over(false);
      add([...e.dataTransfer.files]);
    });
    zone.addEventListener('paste', (e) => {
      const files = pastedPictures(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      add(files);
    });
    return zone;
  }

  return { element, attach, add };
}
