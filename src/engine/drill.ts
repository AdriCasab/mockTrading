import { Rng, mulberry32, pick } from './rng';
import { roundTick } from './market';

// The timed drill SIG trainees ran between pit sessions. Question types follow
// the difficulty tiers: easy is the parity family, medium adds spread and
// straddle identities, hard adds fly/iron-fly and box identities. Every answer
// is positive (the iPhone decimal pad has no minus key) and lands on the cent.
//
// Two styles: 'fair' asks for a single fair value; 'market' gives bid @ ask
// markets and asks where you can buy or sell the counterpart — the drill is
// knowing which side of each given market the replication crosses.
export type DrillQuestion = { prompt: string; answer: number };
export type DrillLevel = 'easy' | 'medium' | 'hard';
export type DrillStyle = 'fair' | 'market';

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

// ---------------------------------------------------------------------------
// Market style: the givens are bid @ ask markets; the answer is the price at
// which the replication actually executes. Same-sign legs cross the same side
// (buy the call = put ask + stock ask); subtracted legs flip (buy the put from
// P&S = package ask MINUS stock bid); short identities flip entirely (buy the
// put spread = 5 minus the call spread BID).
// ---------------------------------------------------------------------------

type Mkt = { bid: number; ask: number };
const f2 = (x: number) => x.toFixed(2);
const mm = (m: Mkt) => `${f2(m.bid)} @ ${f2(m.ask)}`;
const side = (r: Rng): 'buy' | 'sell' => (r.next() < 0.5 ? 'buy' : 'sell');

// Two phrasings for the same number — "where can you buy X?" and "what's your
// ask on X?" are identical: your ask is where you can source it, your bid is
// where you can lay it off. Alternating drills that equivalence.
const question = (r: Rng, sd: 'buy' | 'sell', label: string) =>
  r.next() < 0.5
    ? `Where can you ${sd} the ${label}?`
    : `What's your ${sd === 'buy' ? 'ask' : 'bid'} on the ${label}?`;

function mktAround(r: Rng, mid: number, minBid = 0.05): Mkt | null {
  const w = pick(r, [0.1, 0.2]);
  const bid = roundTick(mid - w / 2);
  if (bid < minBid) return null;
  return { bid, ask: r2(bid + w) };
}

function marketBase(r: Rng) {
  const b = parityBase(r);
  const stk: Mkt = { bid: r2(b.S - 0.1), ask: r2(b.S + 0.1) };
  return { ...b, stk, mbase: `Stock ${mm(stk)}, r/c ${b.rc.toFixed(2)}.` };
}

const mPutToCall: Gen = (r) => {
  const b = marketBase(r);
  const put = mktAround(r, b.putPx);
  if (!put) return null;
  const sd = side(r);
  const answer = sd === 'buy'
    ? r2(put.ask + (b.stk.ask - b.K) + b.rc)
    : r2(put.bid + (b.stk.bid - b.K) + b.rc);
  if (answer < 0.05) return null;
  return { prompt: `${b.mbase} The ${b.K} puts are ${mm(put)}. ${question(r, sd, `${b.K} call`)}`, answer };
};
const mCallToPut: Gen = (r) => {
  const b = marketBase(r);
  if (b.callPx < 0.2) return null;
  const call = mktAround(r, b.callPx);
  if (!call) return null;
  const sd = side(r);
  const answer = sd === 'buy'
    ? r2(call.ask - (b.stk.bid - b.K) - b.rc) // buy call, SELL stock at the bid
    : r2(call.bid - (b.stk.ask - b.K) - b.rc);
  if (answer < 0.05) return null;
  return { prompt: `${b.mbase} The ${b.K} calls are ${mm(call)}. ${question(r, sd, `${b.K} put`)}`, answer };
};
const mBwToPut: Gen = (r) => {
  const b = marketBase(r);
  const bw = mktAround(r, r2(b.putPx + b.rc), b.rc + 0.05);
  if (!bw) return null;
  const sd = side(r);
  const answer = sd === 'buy' ? r2(bw.ask - b.rc) : r2(bw.bid - b.rc); // stock is a distractor
  return { prompt: `${b.mbase} The ${b.K} buy-write is ${mm(bw)}. ${question(r, sd, `${b.K} put`)}`, answer };
};
const mPnsToCall: Gen = (r) => {
  const b = marketBase(r);
  if (b.callPx < b.rc + 0.2) return null;
  const pns = mktAround(r, r2(b.callPx - b.rc));
  if (!pns) return null;
  const sd = side(r);
  const answer = sd === 'buy' ? r2(pns.ask + b.rc) : r2(pns.bid + b.rc); // stock is a distractor
  return { prompt: `${b.mbase} The ${b.K} puts & stock is ${mm(pns)}. ${question(r, sd, `${b.K} call`)}`, answer };
};
const mPnsToPut: Gen = (r) => {
  const b = marketBase(r);
  const pns = mktAround(r, r2(b.putPx + b.S - b.K));
  if (!pns) return null;
  const sd = side(r);
  const answer = sd === 'buy'
    ? r2(pns.ask - (b.stk.bid - b.K)) // buy the package, SELL the stock at the bid
    : r2(pns.bid - (b.stk.ask - b.K));
  if (answer < 0.05) return null;
  return { prompt: `${b.mbase} The ${b.K} puts & stock is ${mm(pns)}. ${question(r, sd, `${b.K} put`)}`, answer };
};
const mBwToCall: Gen = (r) => {
  const b = marketBase(r);
  const bw = mktAround(r, r2(b.putPx + b.rc));
  if (!bw) return null;
  const sd = side(r);
  const answer = sd === 'buy'
    ? r2(bw.ask + (b.stk.ask - b.K)) // same-side stock
    : r2(bw.bid + (b.stk.bid - b.K));
  if (answer < 0.05) return null;
  return { prompt: `${b.mbase} The ${b.K} buy-write is ${mm(bw)}. ${question(r, sd, `${b.K} call`)}`, answer };
};
const mStockToCombo: Gen = (r) => {
  const K = 5 * (12 + Math.floor(r.next() * 21));
  const S = roundTick(K + 0.5 + r.next() * 7.5);
  const rc = pick(r, [0.05, 0.1, 0.15, 0.2]);
  const stk: Mkt = { bid: r2(S - 0.1), ask: r2(S + 0.1) };
  const sd = side(r);
  const answer = sd === 'buy' ? r2(stk.ask - K + rc) : r2(stk.bid - K + rc);
  if (answer < 0.05) return null;
  return { prompt: `Stock ${mm(stk)}, r/c ${rc.toFixed(2)}. ${question(r, sd, `${K} combo`)}`, answer };
};
const mSpreadFlip: Gen = (r) => {
  const K1 = 5 * (12 + Math.floor(r.next() * 20));
  const cs = mktAround(r, roundTick(0.7 + r.next() * 3.5), 0.3);
  if (!cs || cs.ask > 4.7) return null;
  const sd = side(r);
  const answer = sd === 'buy' ? r2(5 - cs.bid) : r2(5 - cs.ask); // opposite side
  return {
    prompt: `The ${K1}/${K1 + 5} call spread is ${mm(cs)}. ${question(r, sd, `${K1}/${K1 + 5} put spread`)}`,
    answer,
  };
};
const mBwPnsToStraddle: Gen = (r) => {
  const b = marketBase(r);
  if (b.callPx < b.rc + 0.2) return null;
  const bw = mktAround(r, r2(b.putPx + b.rc));
  const pns = mktAround(r, r2(b.callPx - b.rc));
  if (!bw || !pns) return null;
  const sd = side(r);
  const answer = sd === 'buy' ? r2(bw.ask + pns.ask) : r2(bw.bid + pns.bid);
  return {
    prompt: `The ${b.K} buy-write is ${mm(bw)}, the ${b.K} puts & stock is ${mm(pns)}. ${question(r, sd, `${b.K} straddle`)}`,
    answer,
  };
};
const mFlyToIron: Gen = (r) => {
  const K = 5 * (13 + Math.floor(r.next() * 19));
  const fly = mktAround(r, roundTick(0.4 + r.next() * 1.4), 0.1);
  if (!fly) return null;
  const sd = side(r);
  const answer = sd === 'buy' ? r2(5 - fly.bid) : r2(5 - fly.ask); // opposite side
  return {
    prompt: `The ${K - 5}/${K}/${K + 5} fly is ${mm(fly)}. ${question(r, sd, `${K} iron fly`)}`,
    answer,
  };
};
const mStradStrangleToIron: Gen = (r) => {
  const K = 5 * (13 + Math.floor(r.next() * 19));
  const strad = mktAround(r, roundTick(4 + r.next() * 6), 1);
  if (!strad) return null;
  const strangle = mktAround(r, roundTick(Math.max(0.5, (strad.bid + strad.ask) / 2 - 0.8 - r.next() * 2.5)), 0.2);
  if (!strangle || strangle.ask >= strad.bid) return null;
  const sd = side(r);
  const answer = sd === 'buy'
    ? r2(strad.ask - strangle.bid) // buy the body, sell the wings at the bid
    : r2(strad.bid - strangle.ask);
  if (answer < 0.05) return null;
  return {
    prompt: `The ${K} straddle is ${mm(strad)}, the ${K - 5}/${K + 5} strangle is ${mm(strangle)}. ${question(r, sd, `${K} iron fly`)}`,
    answer,
  };
};

// --- additional fair-value variety ---

function comboBase(r: Rng) {
  const K = 5 * (12 + Math.floor(r.next() * 21));
  const S = roundTick(K + 0.5 + r.next() * 7.5); // above the strike -> positive combo
  const rc = pick(r, [0.05, 0.1, 0.15, 0.2]);
  return { K, S, rc, combo: r2(S - K + rc) };
}

const qComboPutToCall: Gen = (r) => {
  const c = comboBase(r);
  const putPx = roundTick(0.3 + r.next() * 4);
  return {
    prompt: `The ${c.K} combo is ${f2(c.combo)}, the ${c.K} put is ${f2(putPx)}. Fair for the ${c.K} call?`,
    answer: r2(c.combo + putPx),
  };
};
// The options market implies the stock: S = K + combo - r/c.
const qComboToStock: Gen = (r) => {
  const c = comboBase(r);
  return {
    prompt: `The ${c.K} combo is ${f2(c.combo)}, r/c ${f2(c.rc)}. Fair for the stock?`,
    answer: c.S,
  };
};
const qPsToCs: Gen = (r) => {
  const K1 = 5 * (12 + Math.floor(r.next() * 20));
  const ps = roundTick(0.5 + r.next() * 4);
  return {
    prompt: `The ${K1}/${K1 + 5} put spread is ${f2(ps)}. Fair for the ${K1}/${K1 + 5} call spread?`,
    answer: r2(5 - ps),
  };
};
const qStradPutToCall: Gen = (r) => {
  const K = 5 * (12 + Math.floor(r.next() * 21));
  const putPx = roundTick(0.3 + r.next() * 4);
  const callPx = roundTick(0.3 + r.next() * 4);
  return {
    prompt: `The ${K} straddle is ${f2(r2(putPx + callPx))}, the ${K} put is ${f2(putPx)}. Fair for the ${K} call?`,
    answer: callPx,
  };
};
const qStradCallToPut: Gen = (r) => {
  const K = 5 * (12 + Math.floor(r.next() * 21));
  const putPx = roundTick(0.3 + r.next() * 4);
  const callPx = roundTick(0.3 + r.next() * 4);
  return {
    prompt: `The ${K} straddle is ${f2(r2(putPx + callPx))}, the ${K} call is ${f2(callPx)}. Fair for the ${K} put?`,
    answer: putPx,
  };
};
const qIronToFly: Gen = (r) => {
  const K = 5 * (13 + Math.floor(r.next() * 19));
  const fly = roundTick(0.3 + r.next() * 1.5);
  return {
    prompt: `The ${K} iron fly is ${f2(r2(5 - fly))}. Fair for the ${K - 5}/${K}/${K + 5} fly?`,
    answer: fly,
  };
};
// Trick question: no arithmetic at all — the call fly IS the put fly.
const qCallFlyPutFly: Gen = (r) => {
  const K = 5 * (13 + Math.floor(r.next() * 19));
  const fly = roundTick(0.3 + r.next() * 1.5);
  return {
    prompt: `The ${K - 5}/${K}/${K + 5} call fly is ${f2(fly)}. Fair for the ${K - 5}/${K}/${K + 5} put fly?`,
    answer: fly,
  };
};
const qRr: Gen = (r) => {
  const K = 5 * (13 + Math.floor(r.next() * 19));
  const callPx = roundTick(0.3 + r.next() * 3);
  const rrVal = roundTick(0.1 + r.next() * 2);
  const putPx = r2(callPx + rrVal);
  return {
    prompt: `The ${K - 5} put is ${f2(putPx)}, the ${K + 5} call is ${f2(callPx)}. Fair for the ${K - 5}/${K + 5} risk reversal, puts over?`,
    answer: rrVal,
  };
};
const qCombosToRoll: Gen = (r) => {
  const K = 5 * (12 + Math.floor(r.next() * 21));
  const julCombo = roundTick(0.3 + r.next() * 5);
  const roll = roundTick(0.05 + r.next() * 0.45);
  return {
    prompt: `The Jul ${K} combo is ${f2(julCombo)}, the Aug ${K} combo is ${f2(r2(julCombo + roll))}. Fair for the ${K} Jul/Aug roll?`,
    answer: roll,
  };
};

const PARITY_FAMILY = [
  qPutToCall, qCallToPut, qPutToBw, qCallToPns,
  qPnsToPut, qBwToCall, qBwToPut, qPnsToCall, qCombo,
  qComboPutToCall, qComboToStock,
];

const MARKET_FAMILY = [
  mPutToCall, mCallToPut, mBwToPut, mPnsToCall, mPnsToPut, mBwToCall, mStockToCombo,
];

const GENS_MARKET: Record<DrillLevel, Gen[]> = {
  easy: MARKET_FAMILY,
  medium: [...MARKET_FAMILY, mSpreadFlip, mBwPnsToStraddle],
  hard: [...MARKET_FAMILY, mSpreadFlip, mBwPnsToStraddle, mFlyToIron, mStradStrangleToIron],
};

const GENS: Record<DrillLevel, Gen[]> = {
  easy: PARITY_FAMILY,
  medium: [
    ...PARITY_FAMILY, qSpreadPair, qPsToCs, qStradComboToPut,
    qStradPutToCall, qStradCallToPut, qBwPnsToStraddle,
  ],
  hard: [
    ...PARITY_FAMILY, qSpreadPair, qPsToCs, qStradComboToPut,
    qStradPutToCall, qStradCallToPut, qBwPnsToStraddle,
    qFlyToIronFly, qIronToFly, qCallFlyPutFly, qStradStrangleToIronFly,
    qRr, qCombosToRoll, qBox,
  ],
};

export function makeDrill(
  seed: number,
  n = 15,
  level: DrillLevel = 'easy',
  style: DrillStyle = 'fair'
): DrillQuestion[] {
  const r = mulberry32(seed || 1);
  const gens = style === 'market' ? GENS_MARKET[level] : GENS[level];
  const qs: DrillQuestion[] = [];
  let guard = 0;
  while (qs.length < n && guard++ < n * 30) {
    const q = pick(r, gens)(r);
    if (!q || q.answer < 0.05) continue;
    qs.push(q);
  }
  return qs;
}
