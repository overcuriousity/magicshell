// Number formats shared by every view that draws an answer.
export const prob = (p) => p.toFixed(2);

export const pct = (p) => `${Math.round(p * 100)} %`;

// A score counted from 1, as people number steps; the wire value counts from 0.
export const stepText = (score) => (score + 1).toFixed(1);

// The exact place of a score, e.g. "step 1.7 of 2".
export const stepPlace = (score, count) => `step ${stepText(score)} of ${count}`;

// The level a score is closest to: round half to even, clamped to the levels.
export function nearestLevel(score, count) {
  const floor = Math.floor(score);
  const diff = score - floor;
  let n = floor;
  if (diff > 0.5 || (diff === 0.5 && floor % 2 !== 0)) n = floor + 1;
  return Math.min(Math.max(n, 0), count - 1);
}

export const noulIsYes = (p) => p >= 0.5;

// A change in probability or score: sign always shown except for zero, true minus sign.
export function signed(delta) {
  const text = delta.toFixed(2);
  if (Number(text) === 0) return '0.00';
  return delta > 0 ? `+${text}` : `−${text.slice(1)}`;
}
