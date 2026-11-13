// Colour classes defined in css/40-app.css. Options take the categorical palette by position;
// levels take the four-step ordered ramp, spread so the lowest level is step 1 and the highest step 4.
export const OPTION_SLOTS = 8;
export const LEVEL_STEPS = 4;

export function optionClass(index) {
  return `opt-${(index % OPTION_SLOTS) + 1}`;
}

export function levelClass(index, count) {
  if (count < 2) return `lvl-${LEVEL_STEPS}`;
  return `lvl-${1 + Math.round((index * (LEVEL_STEPS - 1)) / (count - 1))}`;
}
