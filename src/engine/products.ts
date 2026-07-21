import { Env, Right, optTheo } from './market';

export type Leg =
  | { kind: 'opt'; m: number; K: number; right: Right; q: number }
  | { kind: 'stock'; q: number }
  | { kind: 'cash'; amt: number }; // face value banked to expiry (df = 1 world)

export type Product = {
  kind: string;
  label: string;
  legs: Leg[];
  // Signed-price products quote positive with a direction word: `pos` when the
  // internal price is >= 0, `neg` below ('' = no qualifier needed).
  over?: { pos: string; neg: string };
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
  const word = x >= 0 ? p.over.pos : p.over.neg;
  return `${Math.abs(x).toFixed(2)}${word ? ` ${word}` : ''}`;
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

// A teaching derivation of the product's fair, parity/replication with the
// numbers plugged in — shown when the player is punished for mispricing. The
// displayed fair is built from cent-rounded leg theos so the arithmetic always
// adds up on screen. Returns the fair it derived and the one-line working.
export function explainFair(env: Env, p: Product): { fair: number; text: string } {
  const d2 = (x: number) => x.toFixed(2);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const c = (m: number, K: number, right: Right) => r2(optTheo(env, m, K, right));
  const S = env.spot;
  const first = p.legs.find((l): l is Extract<Leg, { kind: 'opt' }> => l.kind === 'opt');
  const m = first ? first.m : 0;
  const rc = env.rc[m];
  const opts = p.legs.filter((l): l is Extract<Leg, { kind: 'opt' }> => l.kind === 'opt');
  const wrap = (fairVal: number, formula: string, plug: string) => ({
    fair: fairVal,
    text: `${formula} = ${plug} = ${d2(fairVal)}`,
  });

  switch (p.kind) {
    case 'call': {
      const K = first!.K;
      const P = c(m, K, 'P');
      return wrap(r2(P + (S - K) + rc), 'C = P + (S−K) + r/c', `${d2(P)} + (${d2(S)}−${K}) + ${d2(rc)}`);
    }
    case 'put': {
      const K = first!.K;
      const C = c(m, K, 'C');
      return wrap(r2(C - (S - K) - rc), 'P = C − (S−K) − r/c', `${d2(C)} − (${d2(S)}−${K}) − ${d2(rc)}`);
    }
    case 'combo': {
      const K = first!.K;
      return wrap(r2(S - K + rc), 'combo = (S−K) + r/c', `(${d2(S)}−${K}) + ${d2(rc)}`);
    }
    case 'bw': {
      const K = first!.K;
      const P = c(m, K, 'P');
      return wrap(r2(P + rc), 'buy-write = P + r/c', `${d2(P)} + ${d2(rc)}`);
    }
    case 'pns': {
      const K = first!.K;
      const C = c(m, K, 'C');
      return wrap(r2(C - rc), 'puts & stock = C − r/c', `${d2(C)} − ${d2(rc)}`);
    }
    case 'straddle': {
      const K = first!.K;
      const C = c(m, K, 'C');
      const P = c(m, K, 'P');
      return wrap(r2(C + P), 'straddle = C + P', `${d2(C)} + ${d2(P)}`);
    }
    case 'strangle': {
      const pl = opts.find((l) => l.right === 'P')!;
      const cl = opts.find((l) => l.right === 'C')!;
      const Pv = c(m, pl.K, 'P');
      const Cv = c(m, cl.K, 'C');
      return wrap(r2(Pv + Cv), `strangle = P${pl.K} + C${cl.K}`, `${d2(Pv)} + ${d2(Cv)}`);
    }
    case 'callSpread': {
      const lo = opts.find((l) => l.q > 0)!;
      const hi = opts.find((l) => l.q < 0)!;
      const a = c(m, lo.K, 'C');
      const b = c(m, hi.K, 'C');
      return wrap(r2(a - b), `call spread = C${lo.K} − C${hi.K}`, `${d2(a)} − ${d2(b)}`);
    }
    case 'putSpread': {
      const lo = opts.find((l) => l.q > 0)!;
      const hi = opts.find((l) => l.q < 0)!;
      const a = c(m, lo.K, 'P');
      const b = c(m, hi.K, 'P');
      return wrap(r2(a - b), `put spread = P${lo.K} − P${hi.K}`, `${d2(a)} − ${d2(b)}`);
    }
    case 'fly': {
      const [a, mid, hi] = [...opts].sort((x, y) => x.K - y.K);
      const av = c(m, a.K, 'C');
      const bv = c(m, mid.K, 'C');
      const cv = c(m, hi.K, 'C');
      return wrap(r2(av - 2 * bv + cv), `fly = C${a.K} − 2·C${mid.K} + C${hi.K}`, `${d2(av)} − 2·${d2(bv)} + ${d2(cv)}`);
    }
    case 'ironFly': {
      const body = opts.find((l) => l.right === 'C' && l.q > 0)!.K;
      const strad = r2(c(m, body, 'C') + c(m, body, 'P'));
      const strangle = r2(c(m, body - 5, 'P') + c(m, body + 5, 'C'));
      return wrap(r2(strad - strangle), 'iron fly = straddle − strangle', `${d2(strad)} − ${d2(strangle)}`);
    }
    case 'box': {
      const Ks = [...new Set(opts.map((l) => l.K))].sort((a, b) => a - b);
      const w = Ks[1] - Ks[0];
      return { fair: w, text: `box = strike width = ${Ks[1]}−${Ks[0]} = ${d2(w)}` };
    }
    case 'rr': {
      const pl = opts.find((l) => l.right === 'P')!;
      const cl = opts.find((l) => l.right === 'C')!;
      const Pv = c(m, pl.K, 'P');
      const Cv = c(m, cl.K, 'C');
      const f = r2(Pv - Cv);
      return { fair: f, text: `risk reversal = P${pl.K} − C${cl.K} = ${d2(Pv)} − ${d2(Cv)} = ${fmtPx(p, f)}` };
    }
    case 'roll': {
      const f = r2(env.rc[1] - env.rc[0]);
      return {
        fair: f,
        text: `roll = r/c(${env.months[1]}) − r/c(${env.months[0]}) = ${d2(env.rc[1])} − ${d2(env.rc[0])} = ${d2(f)}`,
      };
    }
    default:
      return { fair: r2(fair(env, p)), text: `fair ≈ ${d2(fair(env, p))}` };
  }
}

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
  kind: 'rr', label: `${mo(env, m)} ${K - 5}/${K + 5} risk reversal`,
  over: { pos: 'puts over', neg: 'calls over' },
  legs: [opt(m, K - 5, 'P', 1), opt(m, K + 5, 'C', -1)],
});

// Combo: C - P, quoted as the net premium ("0.15 for the 100 combo"). Fair is
// exactly the parity quantity (S - K) + r/c, so combo + K = synthetic stock at
// every strike — a mispriced combo locks against real stock (conversion /
// reversal) or another strike's combo (a box). Above the forward the price
// goes negative and quotes pit-style: "4.70 puts over".
export const combo = (env: Env, m: number, K: number): Product => ({
  kind: 'combo', label: `${mo(env, m)} ${K} combo`,
  legs: [opt(m, K, 'C', 1), opt(m, K, 'P', -1)],
  over: { pos: '', neg: 'puts over' },
});

// Jelly roll: long back-month combo, short front-month combo. Fair = rc2 - rc1.
export const roll = (env: Env, K: number): Product => ({
  kind: 'roll', label: `${K} ${env.months[0]}/${env.months[1]} roll`,
  legs: [opt(1, K, 'C', 1), opt(1, K, 'P', -1), opt(0, K, 'C', -1), opt(0, K, 'P', 1)],
});
