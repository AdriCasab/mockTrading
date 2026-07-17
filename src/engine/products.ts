import { Env, Right, optTheo } from './market';

export type Leg =
  | { kind: 'opt'; m: number; K: number; right: Right; q: number }
  | { kind: 'stock'; q: number }
  | { kind: 'cash'; amt: number }; // face value banked to expiry (df = 1 world)

export type Product = {
  kind: string;
  label: string;
  legs: Leg[];
  over?: boolean; // quoted "puts over / calls over", price may be signed
};

export function fair(env: Env, p: Product): number {
  let v = 0;
  for (const l of p.legs) {
    if (l.kind === 'opt') v += l.q * optTheo(env, l.m, l.K, l.right);
    else if (l.kind === 'stock') v += l.q * env.spot;
    else v += l.amt;
  }
  return v;
}

// Price display: over-style products are always positive with a direction.
export function fmtPx(p: Product, x: number): string {
  if (!p.over) return x.toFixed(2);
  return `${Math.abs(x).toFixed(2)} ${x >= 0 ? 'puts over' : 'calls over'}`;
}

// Plain-language legs from the perspective of buying (sign=1) or selling (sign=-1)
// the quoted package. Cash legs are omitted (banked strike).
export function legsText(env: Env, p: Product, sign: 1 | -1): string {
  const parts: string[] = [];
  for (const l of p.legs) {
    if (l.kind === 'cash') continue;
    const q = l.q * sign;
    if (!q) continue;
    const word = q > 0 ? 'long' : 'short';
    if (l.kind === 'stock') parts.push(`${word} stock`);
    else {
      const mult = Math.abs(q) > 1 ? ` ×${Math.abs(q)}` : '';
      parts.push(`${word} ${env.months[l.m]} ${l.K} ${l.right === 'C' ? 'call' : 'put'}${mult}`);
    }
  }
  return parts.join(', ');
}

const opt = (m: number, K: number, right: Right, q: number): Leg => ({ kind: 'opt', m, K, right, q });
const mo = (env: Env, m: number) => env.months[m];

export const call = (env: Env, m: number, K: number): Product => ({
  kind: 'call', label: `${mo(env, m)} ${K} call`, legs: [opt(m, K, 'C', 1)],
});

export const put = (env: Env, m: number, K: number): Product => ({
  kind: 'put', label: `${mo(env, m)} ${K} put`, legs: [opt(m, K, 'P', 1)],
});

// Quoted vs strike: P + (S - K), fair = C - r/c
export const pns = (env: Env, m: number, K: number): Product => ({
  kind: 'pns', label: `${mo(env, m)} ${K} puts & stock`,
  legs: [opt(m, K, 'P', 1), { kind: 'stock', q: 1 }, { kind: 'cash', amt: -K }],
});

// Quoted vs strike: C - (S - K), fair = P + r/c. Selling this quoted package is
// the classic buy-write (long stock, short call).
export const bw = (env: Env, m: number, K: number): Product => ({
  kind: 'bw', label: `${mo(env, m)} ${K} buy-write`,
  legs: [opt(m, K, 'C', 1), { kind: 'stock', q: -1 }, { kind: 'cash', amt: K }],
});

export const straddle = (env: Env, m: number, K: number): Product => ({
  kind: 'straddle', label: `${mo(env, m)} ${K} straddle`,
  legs: [opt(m, K, 'C', 1), opt(m, K, 'P', 1)],
});

export const strangle = (env: Env, m: number, K: number): Product => ({
  kind: 'strangle', label: `${mo(env, m)} ${K - 5}/${K + 5} strangle`,
  legs: [opt(m, K - 5, 'P', 1), opt(m, K + 5, 'C', 1)],
});

export const callSpread = (env: Env, m: number, K: number): Product => ({
  kind: 'callSpread', label: `${mo(env, m)} ${K}/${K + 5} call spread`,
  legs: [opt(m, K, 'C', 1), opt(m, K + 5, 'C', -1)],
});

export const putSpread = (env: Env, m: number, K: number): Product => ({
  kind: 'putSpread', label: `${mo(env, m)} ${K}/${K + 5} put spread`,
  legs: [opt(m, K + 5, 'P', 1), opt(m, K, 'P', -1)],
});

export const fly = (env: Env, m: number, K: number): Product => ({
  kind: 'fly', label: `${mo(env, m)} ${K - 5}/${K}/${K + 5} fly`,
  legs: [opt(m, K - 5, 'C', 1), opt(m, K, 'C', -2), opt(m, K + 5, 'C', 1)],
});

// Straddle minus strangle (long the body, short the wings): fly + iron fly = width.
export const ironFly = (env: Env, m: number, K: number): Product => ({
  kind: 'ironFly', label: `${mo(env, m)} ${K} iron fly`,
  legs: [opt(m, K, 'P', 1), opt(m, K, 'C', 1), opt(m, K - 5, 'P', -1), opt(m, K + 5, 'C', -1)],
});

export const box = (env: Env, m: number, K1: number, K2: number): Product => ({
  kind: 'box', label: `${mo(env, m)} ${K1}/${K2} box`,
  legs: [opt(m, K1, 'C', 1), opt(m, K2, 'C', -1), opt(m, K2, 'P', 1), opt(m, K1, 'P', -1)],
});

// Long the downside put, short the upside call. Fair = P(K-5) - C(K+5), signed;
// quoted positive with "puts over" / "calls over".
export const rr = (env: Env, m: number, K: number): Product => ({
  kind: 'rr', label: `${mo(env, m)} ${K - 5}/${K + 5} risk reversal`, over: true,
  legs: [opt(m, K - 5, 'P', 1), opt(m, K + 5, 'C', -1)],
});

// Combo quoted vs strike: K + C - P = synthetic stock. Under constant r/c its
// fair is S + r/c at EVERY strike — the same synthetic stock hides at each
// line, so a mispriced combo locks against real stock (conversion/reversal)
// or against another strike's combo (a box).
export const combo = (env: Env, m: number, K: number): Product => ({
  kind: 'combo', label: `${mo(env, m)} ${K} combo`,
  legs: [opt(m, K, 'C', 1), opt(m, K, 'P', -1), { kind: 'cash', amt: K }],
});

// Jelly roll: long back-month combo, short front-month combo. Fair = rc2 - rc1.
export const roll = (env: Env, K: number): Product => ({
  kind: 'roll', label: `${K} ${env.months[0]}/${env.months[1]} roll`,
  legs: [opt(1, K, 'C', 1), opt(1, K, 'P', -1), opt(0, K, 'C', -1), opt(0, K, 'P', 1)],
});
