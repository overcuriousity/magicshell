// The addresses of the views, in one place.
export const hrefOf = (view, id) => (id == null ? `#/${view}` : `#/${view}/${encodeURIComponent(id)}`);

export const HREF = {
  ask: '#/ask',
  bench: '#/ask/bench',
  history: '#/history',
  signIn: '#/sign-in',
};
