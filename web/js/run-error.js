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

// The server's one-sentence body, or a fallback when it is empty or a web page.
export function serverSentence(text, status) {
  const t = text.trim();
  if (t === '' || t.startsWith('<')) return `The server answered with an error (${status}). Try again later.`;
  return t;
}
