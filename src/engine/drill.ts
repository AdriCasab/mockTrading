import { Rng, mulberry32, pick } from './rng';
import { roundTick } from './market';

// The timed drill SIG trainees ran between pit sessions. Question types follow
// the difficulty tiers: easy is the parity family, medium adds spread and
// straddle identities, hard adds fly/iron-fly and box identities. Every answer
// is positive (the iPhone decimal pad has no minus key) and lands on the cent.
export type DrillQuestion = { prompt: string; answer: number };
export type DrillLevel = 'easy' | 'medium' | 'hard';

const r2 = (x: number) => Math.round(x * 100) / 100;

type Gen = (r: Rng) => DrillQuestion | null;

function parityBase(r: Rng) {
  const K = 5 * (12 + Math.floor(r.next() * 21)); // 60..160
  const S = roundTick(K + (r.next() * 16 - 8)); // within ±8 of strike
  const rc = pick(r, [0.05, 0.1, 0.15, 0.2]);
  const parity = r2(S - K + rc); // C - P
  const putPx = roundTick(0.3 + r.next() * 4);
  const callPx = r2(putPx + parity);
  return { K, S, rc, parity, putPx, callPx, base: `Stock ${S.toFixed(2)}, r/c ${rc.toFixed(2)}.` };
}

const qPutToCall: Gen = (r) => {
  const b = parityBase(r);
  if (b.callPx < 0.05) return null;
  return { prompt: `${b.base} The ${b.K} put is ${b.putPx.toFixed(2)}. Fair for the ${b.K} call?`, answer: b.callPx };
};
const qCallToPut: Gen = (r) => {
  const b = parityBase(r);
  if (b.callPx < 0.05) return null;
  return { prompt: `${b.base} The ${b.K} call is ${b.callPx.toFixed(2)}. Fair for the ${b.K} put?`, answer: b.putPx };
};
const qPutToBw: Gen = (r) => {
  const b = parityBase(r);
  return { prompt: `${b.base} The ${b.K} put is ${b.putPx.toFixed(2)}. Fair for the ${b.K} buy-write?`, answer: r2(b.putPx + b.rc) };
};
const qCallToPns: Gen = (r) => {
  const b = parityBase(r);
  if (b.callPx < b.rc + 0.05) return null;
  return { prompt: `${b.base} The ${b.K} call is ${b.callPx.toFixed(2)}. Fair for the ${b.K} puts & stock?`, answer: r2(b.callPx - b.rc) };
};
// Reverse conversions: given the package, recover the option. The prompts
// always show both stock and r/c — part of the drill is knowing which one
// matters (r/c is a distractor for P&S -> put, stock for BW -> put).
const qPnsToPut: Gen = (r) => {
  const b = parityBase(r);
  const pns = r2(b.putPx + b.S - b.K);
  if (pns < 0.05) return null;
  return { prompt: `${b.base} The ${b.K} puts & stock is ${pns.toFixed(2)}. Fair for the ${b.K} put?`, answer: b.putPx };
};
const qBwToCall: Gen = (r) => {
  const b = parityBase(r);
  if (b.callPx < 0.05) return null;
  const bw = r2(b.putPx + b.rc); // = callPx - (S - K)
  return { prompt: `${b.base} The ${b.K} buy-write is ${bw.toFixed(2)}. Fair for the ${b.K} call?`, answer: b.callPx };
};
const qBwToPut: Gen = (r) => {
  const b = parityBase(r);
  const bw = r2(b.putPx + b.rc);
  return { prompt: `${b.base} The ${b.K} buy-write is ${bw.toFixed(2)}. Fair for the ${b.K} put?`, answer: b.putPx };
};
const qPnsToCall: Gen = (r) => {
  const b = parityBase(r);
  if (b.callPx < b.rc + 0.05) return null;
  const pns = r2(b.callPx - b.rc);
  return { prompt: `${b.base} The ${b.K} puts & stock is ${pns.toFixed(2)}. Fair for the ${b.K} call?`, answer: b.callPx };
};
// BW + P&S = (P + r/c) + (C - r/c) = the straddle: the carries cancel.
const qBwPnsToStraddle: Gen = (r) => {
  const b = parityBase(r);
  if (b.callPx < b.rc + 0.05) return null;
  const bw = r2(b.putPx + b.rc);
  const pns = r2(b.callPx - b.rc);
  return {
    prompt: `The ${b.K} buy-write is ${bw.toFixed(2)}, the ${b.K} puts & stock is ${pns.toFixed(2)}. Fair for the ${b.K} straddle?`,
    answer: r2(b.callPx + b.putPx),
  };
};
const qCombo: Gen = (r) => {
  const K = 5 * (12 + Math.floor(r.next() * 21));
  const S = roundTick(K + 0.5 + r.next() * 7.5); // above the strike -> positive combo
  const rc = pick(r, [0.05, 0.1, 0.15, 0.2]);
  return {
    prompt: `Stock ${S.toFixed(2)}, r/c ${rc.toFixed(2)}. Fair for the ${K} combo?`,
    answer: r2(S - K + rc),
  };
};
const qSpreadPair: Gen = (r) => {
  const K1 = 5 * (12 + Math.floor(r.next() * 20));
  const cs = roundTick(0.5 + r.next() * 4);
  return {
    prompt: `The ${K1}/${K1 + 5} call spread is ${cs.toFixed(2)}. Fair for the ${K1}/${K1 + 5} put spread?`,
    answer: r2(5 - cs),
  };
};
const qStradComboToPut: Gen = (r) => {
  const K = 5 * (12 + Math.floor(r.next() * 21));
  const S = roundTick(K + 0.5 + r.next() * 7.5);
  const rc = pick(r, [0.05, 0.1, 0.15, 0.2]);
  const combo = r2(S - K + rc);
  const putPx = roundTick(0.3 + r.next() * 4);
  const straddle = r2(2 * putPx + combo); // C + P where C = P + combo
  return {
    prompt: `The ${K} straddle is ${straddle.toFixed(2)}, the ${K} combo is ${combo.toFixed(2)}. Fair for the ${K} put?`,
    answer: putPx,
  };
};
const qFlyToIronFly: Gen = (r) => {
  const K = 5 * (13 + Math.floor(r.next() * 19));
  const fly = roundTick(0.3 + r.next() * 1.5);
  return {
    prompt: `The ${K - 5}/${K}/${K + 5} fly is ${fly.toFixed(2)}. Fair for the ${K} iron fly?`,
    answer: r2(5 - fly),
  };
};
const qStradStrangleToIronFly: Gen = (r) => {
  const K = 5 * (13 + Math.floor(r.next() * 19));
  const straddle = roundTick(4 + r.next() * 6);
  const strangle = roundTick(Math.max(0.3, straddle - 0.5 - r.next() * 3));
  if (strangle >= straddle) return null;
  return {
    prompt: `The ${K} straddle is ${straddle.toFixed(2)}, the ${K - 5}/${K + 5} strangle is ${strangle.toFixed(2)}. Fair for the ${K} iron fly?`,
    answer: r2(straddle - strangle),
  };
};
const qBox: Gen = (r) => {
  const K1 = 5 * (12 + Math.floor(r.next() * 19));
  const w = pick(r, [5, 5, 10]);
  const S = roundTick(K1 + (r.next() * 16 - 8));
  const rc = pick(r, [0.05, 0.1, 0.15, 0.2]);
  return {
    prompt: `Stock ${S.toFixed(2)}, r/c ${rc.toFixed(2)}. Fair for the ${K1}/${K1 + w} box?`,
    answer: w,
  };
};

const PARITY_FAMILY = [
  qPutToCall, qCallToPut, qPutToBw, qCallToPns,
  qPnsToPut, qBwToCall, qBwToPut, qPnsToCall, qCombo,
];

const GENS: Record<DrillLevel, Gen[]> = {
  easy: PARITY_FAMILY,
  medium: [...PARITY_FAMILY, qSpreadPair, qStradComboToPut, qBwPnsToStraddle],
  hard: [
    ...PARITY_FAMILY, qSpreadPair, qStradComboToPut, qBwPnsToStraddle,
    qFlyToIronFly, qStradStrangleToIronFly, qBox,
  ],
};

export function makeDrill(seed: number, n = 15, level: DrillLevel = 'easy'): DrillQuestion[] {
  const r = mulberry32(seed || 1);
  const gens = GENS[level];
  const qs: DrillQuestion[] = [];
  let guard = 0;
  while (qs.length < n && guard++ < n * 30) {
    const q = pick(r, gens)(r);
    if (!q || q.answer < 0.05) continue;
    qs.push(q);
  }
  return qs;
}
