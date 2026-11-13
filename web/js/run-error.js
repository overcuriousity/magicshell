// The one error both clients reject with. kind: validation | auth | limit | network | upstream.
export class RunError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'RunError';
    this.kind = kind;
  }
}
