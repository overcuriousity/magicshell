// The one error the client and the server store reject with. kind: validation | auth | limit | network | upstream.
export class RunError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'RunError';
    this.kind = kind;
  }
}

export const OFFLINE = 'The server cannot be reached. Check your connection and try again.';
const GENERIC = 'Something went wrong. Reload the page and try again.';

// The sentence a person is shown: a RunError's own, never the text of any other error.
export const messageOf = (e) => (e instanceof RunError && e.message ? e.message : GENERIC);

// The server's own sentence, or a fallback for anything else: an empty body, a web page, JSON or
// the text of a proxy in front of the server. The app's sentences are one short line ending in a full stop.
export function serverSentence(text, status) {
  const t = text.trim();
  const own = t.length > 0 && t.length <= 300 && !/[\r\n]/.test(t) && /[.?!]$/.test(t) && !/^[<{[]/.test(t);
  return own ? t : `The server answered with an error (${status}). Try again later.`;
}
