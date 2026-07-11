function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export const cnd = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

function d1(F: number, K: number, vol: number, T: number): number {
  const s = vol * Math.sqrt(T);
  return Math.log(F / K) / s + s / 2;
}

// Undiscounted Black-76: C - P = F - K exactly, which is the game's parity
// once F is defined as spot + r/c.
export function black76Call(F: number, K: number, vol: number, T: number): number {
  if (T <= 0 || vol <= 0) return Math.max(F - K, 0);
  const a = d1(F, K, vol, T);
  return F * cnd(a) - K * cnd(a - vol * Math.sqrt(T));
}

export function black76CallDelta(F: number, K: number, vol: number, T: number): number {
  if (T <= 0 || vol <= 0) return F > K ? 1 : 0;
  return cnd(d1(F, K, vol, T));
}
