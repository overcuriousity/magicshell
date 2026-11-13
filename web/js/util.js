// Small helpers the modules share.

// A plain object: not null, not an array.
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A deep copy of JSON data.
export const copy = (v) => JSON.parse(JSON.stringify(v));

// Text trimmed, or '' for anything that is not text.
export const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');

// Length in characters (code points), not UTF-16 units, so Rust's chars().count() agrees.
export const len = (s) => [...s].length;
