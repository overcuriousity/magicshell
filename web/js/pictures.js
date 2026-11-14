// Pictures of the situation: a file is shrunk in the browser to a JPEG data URL and a small
// preview before it is sent. Re-encoding also drops the file's metadata. Everything but
// `browserCodec` is free of the DOM; the decoder and encoder are passed in.
import { LIMITS } from './limits.js';
import { RunError } from './run-error.js';
import { dataUrlBytes } from './systemone.js';

const QUALITIES = [0.85, 0.7, 0.5];
// Preview attempts as [edge, quality], until one fits LIMITS.previewChars.
const PREVIEWS = [[96, 0.6], [96, 0.4], [64, 0.4]];

export const TOO_LARGE = 'This picture is too large even after shrinking.';
export const TOO_LARGE_TOGETHER = 'These pictures are too large together. Remove one first.';
export const UNREADABLE = 'This picture cannot be read. Try a JPEG or PNG.';
const leftOut = (max) => (max === 1 ? 'Only 1 picture fits. The others were left out.' : `Only ${max} pictures fit. The others were left out.`);

// The size with the long edge at most `edge`: the shape kept, never enlarged, at least 1 px.
export function targetSize(width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function preview(source, encode) {
  for (const [edge, quality] of PREVIEWS) {
    const size = targetSize(source.width, source.height, edge);
    const url = await encode(source, size.width, size.height, quality);
    if (dataUrlBytes(url) !== null && url.length <= LIMITS.previewChars) return url;
  }
  return null;
}

// source: { width, height } and whatever `encode(source, width, height, quality)` draws from;
// encode resolves to a JPEG data URL. Resolves to { id, url, width, height, bytes, preview }.
export async function shrink(source, { edge, encode, uid }) {
  const { width, height } = targetSize(source.width, source.height, edge);
  for (const quality of QUALITIES) {
    const url = await encode(source, width, height, quality);
    const bytes = dataUrlBytes(url);
    if (bytes === null) throw new RunError(UNREADABLE, 'validation');
    if (bytes <= LIMITS.pictureBytes) return { id: uid(), url, width, height, bytes, preview: await preview(source, encode) };
  }
  throw new RunError(TOO_LARGE, 'validation');
}

// Adds `files` to the pictures already `held`, in order, as far as the count and the run's byte
// budget allow. Resolves to the new list and one sentence per kind of problem.
export async function addFiles(files, held, { max, edge, decode, encode, uid }) {
  const pictures = [...held];
  const problems = new Set();
  for (const file of files) {
    if (pictures.length >= max) {
      problems.add(leftOut(max));
      break;
    }
    let source;
    try {
      source = await decode(file);
    } catch {
      problems.add(UNREADABLE);
      continue;
    }
    try {
      const picture = await shrink(source, { edge, encode, uid });
      const together = pictures.reduce((sum, p) => sum + p.bytes, picture.bytes);
      if (together > LIMITS.picturesBytes) problems.add(TOO_LARGE_TOGETHER);
      else pictures.push(picture);
    } catch (e) {
      problems.add(e instanceof RunError ? e.message : UNREADABLE);
    } finally {
      source.close?.();
    }
  }
  return { pictures, problems: [...problems] };
}

// The browser's decoder and encoder. The picture is turned upright as its EXIF data says, and
// transparent parts become white.
export function browserCodec(doc = document) {
  return {
    decode: (file) => createImageBitmap(file, { imageOrientation: 'from-image' }),
    async encode(bitmap, width, height, quality) {
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, width, height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', quality);
    },
  };
}

// Pictures stay in memory only: a draft in sessionStorage names them by id, and this is where a
// model built again in the same tab (another view, sign-in) finds them. After a reload it is
// empty, and the draft says how many are gone.
const memories = new Set();
export function pictureMemory() {
  let held = new Map();
  const memory = {
    keep(pictures) {
      held = new Map(pictures.map((p) => [p.id, p]));
    },
    // The pictures with these ids, in this order; null when one of them is gone.
    recall(ids) {
      const found = ids.map((id) => held.get(id));
      return found.every(Boolean) ? found : null;
    },
  };
  memories.add(memory);
  return memory;
}
// Nothing one person added stays for the next.
export function forgetPictures() {
  for (const m of memories) m.keep([]);
}

export const lostNotice = (n) =>
  n === 1
    ? 'This run had 1 picture. History keeps only previews; add it again to ask the same.'
    : `This run had ${n} pictures. History keeps only previews; add them again to ask the same.`;

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

// "1 of 4 · 768×576 · 84 KB", "2 of 4 · 212 KB together", or '' without pictures.
export function picturesLine(pictures, max) {
  if (pictures.length === 0) return '';
  const count = `${pictures.length} of ${max}`;
  if (pictures.length === 1) return `${count} · ${pictures[0].width}×${pictures[0].height} · ${kb(pictures[0].bytes)}`;
  return `${count} · ${kb(pictures.reduce((sum, p) => sum + p.bytes, 0))} together`;
}

// A picture as the request view shows it: its size instead of its content.
export const shortPicture = (bytes) => `data:image/jpeg;base64,…(${kb(bytes)})`;

export function shortUrl(url) {
  const bytes = dataUrlBytes(url);
  return bytes === null ? url : shortPicture(bytes);
}

export { kb as kilobytes };
