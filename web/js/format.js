// Number formats shared by every view that draws an answer.
export const prob = (p) => p.toFixed(2);

export const pct = (p) => `${Math.round(p * 100)} %`;

export const scoreText = (score) => score.toFixed(1);

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
