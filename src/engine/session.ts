import { Rng, mulberry32, pick, normal } from './rng';
import {
  Env, Right, makeEnv, optTheo, optDelta, roundTick, TICK, fmt, strikeSkew,
  stockBid, stockAsk,
} from './market';
import * as P from './products';
import { Product, fair, fmtPx, legsText } from './products';

export type Noise = 0 | 1 | 2;

// Product tiers for the difficulty setting. Custom sessions pass any subset.
export const PRODUCT_SETS = (() => {
  const easy = ['call', 'put', 'pns', 'bw', 'combo'];
  const medium = [...easy, 'straddle', 'callSpread', 'putSpread'];
  const hard = [...medium, 'strangle', 'fly', 'ironFly', 'box', 'rr', 'roll'];
  return { easy, medium, hard };
})();

export type SessionConfig = {
  seed: number;
  rounds: number; // ticks of pit time
  noise: Noise;
  twoExp: boolean;
  shotClock: number; // seconds per tick, 0 = advance manually
  products: string[]; // product kinds the brokers may quote
};

// A live order resting in the pit. side is the broker's side: a 'bid' order
// means the broker pays that price (you can sell to him). size is the lot
// count — fills are all-or-none at the full size.
export type RestingOrder = {
  id: number;
  broker: string;
  product: Product;
  side: 'bid' | 'ask';
  price: number;
  size: number;
  ttl: number; // ticks until the broker pulls it
  planted: boolean; // constructed to be arbitrage-able (for debrief stats)
  born: number; // tick the order (or its arb, after an improvement) appeared
};

export type MMRequest = { product: Product; fair: number; ttl: number };

export type FeedItem = { round: number; who: 'inst' | 'crowd' | 'you' | 'game'; text: string };

export type Decision = {
  round: number;
  label: string;
  action: string;
  fair: number;
  edge: number;
  note?: string;
};

export type Quote = { bid: number; ask: number };

export type GameState = {
  cfg: SessionConfig;
  env: Env;
  rng: number;
  quotes: Record<string, Quote>;
  round: number;
  orders: RestingOrder[];
  mm: MMRequest | null;
  nextId: number;
  arbsSeen: number;
  arbsCaptured: number;
  captureTicks: number[]; // how many ticks each captured arb had been resting
  recentLabels: string[]; // last few quoted products, for variety
  feed: FeedItem[];
  decisions: Decision[];
  posOpt: Record<string, number>;
  posStock: number;
  cash: number;
  banked: number; // face value banked to expiry from vs-strike packages
  phase: 'playing' | 'debrief';
};

export type Action =
  | { type: 'order'; id: number }
  | { type: 'tick' }
  | { type: 'mm'; bid: number; ask: number }
  | { type: 'pass' }
  | { type: 'board'; m: number; K: number; right: Right; side: 'bid' | 'ask'; size?: number }
  | { type: 'stock'; side: 'bid' | 'ask'; size?: number }
  | { type: 'unwind' }
  | { type: 'net'; keys: string[] };

export const cellKey = (m: number, K: number, right: Right) => `${m}|${K}|${right}`;

const EPS = 0.011;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

// One lot is a standard 100-share contract. Prices stay quoted per share the
// way the pit talks; money displays convert to actual dollars.
export const CONTRACT_MULT = 100;
export function usd(x: number): string {
  const cents = Math.round(x * CONTRACT_MULT * 100);
  const abs = Math.abs(cents);
  const body = abs % 100 === 0 ? (abs / 100).toFixed(0) : (abs / 100).toFixed(2);
  return `${cents < 0 ? '-' : '+'}$${body}`;
}

function feed(s: GameState, who: FeedItem['who'], text: string) {
  s.feed.unshift({ round: s.round, who, text });
  if (s.feed.length > 60) s.feed.pop();
}

function allCells(env: Env): { m: number; K: number; right: Right }[] {
  const out: { m: number; K: number; right: Right }[] = [];
  for (let m = 0; m < env.months.length; m++)
    for (const K of env.strikes) for (const right of ['C', 'P'] as Right[]) out.push({ m, K, right });
  return out;
}

function emptyCells(s: GameState) {
  return allCells(s.env).filter((c) => !s.quotes[cellKey(c.m, c.K, c.right)]);
}

function mkQuote(env: Env, m: number, K: number, right: Right): Quote {
  const t = optTheo(env, m, K, right);
  const w = t >= 1.5 ? 0.2 : 0.1;
  const bid = Math.max(0, roundTick(t - w / 2 + strikeSkew(env, m, K)));
  return { bid, ask: roundTick(bid + w) };
}

function crowdFill(s: GameState, r: Rng, announce = true) {
  const empties = emptyCells(s);
  if (!empties.length) return;
  const nearby = empties.filter((c) => Math.abs(c.K - s.env.spot) <= 10);
  const c = pick(r, nearby.length ? nearby : empties);
  const q = mkQuote(s.env, c.m, c.K, c.right);
  s.quotes[cellKey(c.m, c.K, c.right)] = q;
  if (announce)
    feed(s, 'crowd',
      `Crowd makes ${fmt(q.bid)} at ${fmt(q.ask)} on the ${s.env.months[c.m]} ${c.K} ${c.right === 'C' ? 'calls' : 'puts'}.`);
}

// The crowd re-centers the board when the stock moves, but resting broker
// orders do NOT reprice — a stale order after a stock move is the classic
// pit arbitrage.
function stockMove(s: GameState, r: Rng) {
  const d = roundTick(Math.max(-1, Math.min(1, normal(r) * 0.35)));
  if (d === 0) return;
  s.env = { ...s.env, spot: roundTick(s.env.spot + d) };
  for (const key of Object.keys(s.quotes)) {
    const [m, K, right] = key.split('|');
    s.quotes[key] = mkQuote(s.env, Number(m), Number(K), right as Right);
  }
  feed(s, 'game',
    `Stock ${d > 0 ? 'ticks up' : 'ticks down'} to ${fmt(stockBid(s.env))} @ ${fmt(stockAsk(s.env))} — crowd refreshes; the brokers' orders stand.`);
}

function instPrice(s: GameState, r: Rng, f: number, side: 'bid' | 'ask'): number {
  const maxTicks = 2 + 2 * s.cfg.noise;
  const zeroP = [0.4, 0.3, 0.25][s.cfg.noise];
  const mag = r.next() < zeroP ? 0 : 1 + Math.floor(r.next() * maxTicks);
  const err = (r.next() < 0.5 ? -1 : 1) * mag * TICK;
  return roundTick(side === 'bid' ? f - TICK + err : f + TICK + err);
}

function buildProduct(s: GameState, r: Rng, kind: string): Product | null {
  const env = s.env;
  const m = env.months.length > 1 ? (r.next() < 0.5 ? 0 : 1) : 0;
  const inner = env.strikes.slice(1, 4);
  const lower = env.strikes.slice(0, 4);
  switch (kind) {
    case 'call': case 'put': {
      const Ks = env.strikes.filter((K) => optTheo(env, m, K, kind === 'call' ? 'C' : 'P') >= 0.15);
      if (!Ks.length) return null;
      const K = pick(r, Ks);
      return kind === 'call' ? P.call(env, m, K) : P.put(env, m, K);
    }
    case 'bw': return P.bw(env, m, pick(r, env.strikes));
    case 'pns': return P.pns(env, m, pick(r, env.strikes));
    case 'combo': return P.combo(env, m, pick(r, env.strikes));
    case 'straddle': return P.straddle(env, m, pick(r, inner));
    case 'strangle': return P.strangle(env, m, pick(r, inner));
    case 'callSpread': return P.callSpread(env, m, pick(r, lower));
    case 'putSpread': return P.putSpread(env, m, pick(r, lower));
    case 'fly': return P.fly(env, m, pick(r, inner));
    case 'ironFly': return P.ironFly(env, m, pick(r, inner));
    case 'box': {
      const K = pick(r, lower);
      const wide = r.next() < 0.3 && env.strikes.includes(K + 10);
      return P.box(env, m, K, wide ? K + 10 : K + 5);
    }
    case 'rr': return P.rr(env, m, pick(r, inner));
    case 'roll': return env.months.length > 1 ? P.roll(env, pick(r, env.strikes)) : null;
    default: return null;
  }
}

function strikeKnown(s: GameState, m: number, K: number): boolean {
  return !!(s.quotes[cellKey(m, K, 'C')] || s.quotes[cellKey(m, K, 'P')]);
}

function productAnchored(s: GameState, p: Product): boolean {
  return p.legs.every((l) => l.kind !== 'opt' || strikeKnown(s, l.m, l.K));
}

function singleCellKey(p: Product): string {
  const l = p.legs[0];
  if (l.kind !== 'opt') throw new Error('not a single option');
  return cellKey(l.m, l.K, l.right);
}

// ---------------------------------------------------------------------------
// Closure engine: the best price at which one unit of an instrument can be
// bought or sold RIGHT NOW, using the board directly or synthetically via
// put-call parity at the same strike (crossing the stock spread). This is what
// makes an order arbitrage-able "for free": sell it, buy the legs back, flat.
// Prices are in quoted (vs-strike) space, banked cash at face.
// ---------------------------------------------------------------------------

export function bestBuy(s: GameState, m: number, K: number, right: Right): number | null {
  const env = s.env;
  const rc = env.rc[m];
  const direct = s.quotes[cellKey(m, K, right)]?.ask;
  const other = s.quotes[cellKey(m, K, right === 'C' ? 'P' : 'C')];
  const synth = other === undefined ? undefined : right === 'C'
    ? other.ask + (stockAsk(env) - K) + rc // buy put, buy stock
    : other.ask - (stockBid(env) - K) - rc; // buy call, sell stock
  const c = [direct, synth].filter((x): x is number => x !== undefined);
  return c.length ? Math.min(...c) : null;
}

export function bestSell(s: GameState, m: number, K: number, right: Right): number | null {
  const env = s.env;
  const rc = env.rc[m];
  const direct = s.quotes[cellKey(m, K, right)]?.bid;
  const other = s.quotes[cellKey(m, K, right === 'C' ? 'P' : 'C')];
  const synth = other === undefined ? undefined : right === 'C'
    ? other.bid + (stockBid(env) - K) + rc // sell put, sell stock
    : other.bid - (stockAsk(env) - K) - rc; // sell call, buy stock
  const c = [direct, synth].filter((x): x is number => x !== undefined);
  return c.length ? Math.max(...c) : null;
}

export function closureBuyCost(s: GameState, p: Product): number | null {
  let cost = 0;
  for (const l of p.legs) {
    if (l.kind === 'cash') { cost += l.amt; continue; }
    if (l.kind === 'stock') { cost += l.q * (l.q > 0 ? stockAsk(s.env) : stockBid(s.env)); continue; }
    const px = l.q > 0 ? bestBuy(s, l.m, l.K, l.right) : bestSell(s, l.m, l.K, l.right);
    if (px === null) return null;
    cost += l.q * px;
  }
  return cost;
}

export function closureSellValue(s: GameState, p: Product): number | null {
  let value = 0;
  for (const l of p.legs) {
    if (l.kind === 'cash') { value += l.amt; continue; }
    if (l.kind === 'stock') { value += l.q * (l.q > 0 ? stockBid(s.env) : stockAsk(s.env)); continue; }
    const px = l.q > 0 ? bestSell(s, l.m, l.K, l.right) : bestBuy(s, l.m, l.K, l.right);
    if (px === null) return null;
    value += l.q * px;
  }
  return value;
}

// Riskless profit available from trading against this order and immediately
// flattening: via the board/synthetics, or via another broker's opposite
// order in the identical product.
export function orderArbProfit(s: GameState, o: RestingOrder): number | null {
  const key = JSON.stringify(o.product.legs);
  let best: number | undefined;
  for (const o2 of s.orders) {
    if (o2.id === o.id || o2.side === o.side) continue;
    if (JSON.stringify(o2.product.legs) !== key) continue;
    const pr = o.side === 'bid' ? o.price - o2.price : o2.price - o.price;
    best = best === undefined ? pr : Math.max(best, pr);
  }
  const cl = o.side === 'bid' ? closureBuyCost(s, o.product) : closureSellValue(s, o.product);
  if (cl !== null) {
    const pr = o.side === 'bid' ? o.price - cl : cl - o.price;
    best = best === undefined ? pr : Math.max(best, pr);
  }
  return best === undefined ? null : best;
}

// ---------------------------------------------------------------------------
// The pit: several brokers with live resting orders at once.
// ---------------------------------------------------------------------------

const BROKERS = ['Rich', 'Sal', 'Dana', 'Moe', 'Vera'];

// The session still arcs from singles to structures, but only ever within the
// player's enabled product set; if a phase has nothing enabled, draw from the
// whole set instead.
function phaseKinds(s: GameState): string[] {
  const frac = s.round / s.cfg.rounds;
  const tier =
    frac <= 0.35
      ? ['call', 'put', 'bw', 'pns', 'combo']
      : frac <= 0.7
        ? ['straddle', 'callSpread', 'putSpread', 'call', 'put', 'bw', 'combo']
        : ['strangle', 'fly', 'ironFly', 'box', 'rr', 'straddle', 'roll', 'roll', 'combo'];
  const ok = (k: string) => s.cfg.products.includes(k) && (k !== 'roll' || s.cfg.twoExp);
  let kinds = tier.filter(ok);
  if (!kinds.length) kinds = s.cfg.products.filter(ok);
  if (!kinds.length) kinds = ['call', 'put'];
  return kinds;
}

function mkOrderProduct(s: GameState, r: Rng): { product: Product; f: number } | null {
  const kinds = phaseKinds(s);
  for (let tries = 0; tries < 25; tries++) {
    const product = buildProduct(s, r, pick(r, kinds));
    if (!product) continue;
    if (!productAnchored(s, product)) continue;
    // Variety: avoid re-quoting something recently in the pit, unless the
    // product space is too small to avoid it.
    if (tries < 15 && s.recentLabels.includes(product.label)) continue;
    const f = fair(s.env, product);
    if (!product.over && f < 0.15) continue;
    return { product, f };
  }
  return null;
}

function orderFeedText(o: RestingOrder): string {
  return o.side === 'bid'
    ? `${o.broker} pays ${fmtPx(o.product, o.price)} for the ${o.product.label}, ${o.size} up.`
    : `${o.broker} offers the ${o.product.label} at ${fmtPx(o.product, o.price)}, ${o.size} up.`;
}

function pushOrder(s: GameState, r: Rng, planted: boolean): boolean {
  const pf = mkOrderProduct(s, r);
  if (!pf) return false;
  const side: 'bid' | 'ask' = r.next() < 0.5 ? 'bid' : 'ask';
  let price: number;
  if (planted) {
    const base = side === 'bid' ? closureBuyCost(s, pf.product) : closureSellValue(s, pf.product);
    if (base === null) return false;
    const p = (1 + Math.floor(r.next() * 3)) * TICK;
    price = roundTick(side === 'bid' ? base + p : base - p);
  } else {
    price = instPrice(s, r, pf.f, side);
  }
  if (!pf.product.over && price < TICK) return false;
  const o: RestingOrder = {
    id: s.nextId++, broker: pick(r, BROKERS), product: pf.product, side, price,
    size: pick(r, [5, 10, 10, 20]),
    ttl: 2 + Math.floor(r.next() * (planted ? 2 : 3)), planted,
    born: s.round,
  };
  s.orders.push(o);
  s.recentLabels.push(o.product.label);
  if (s.recentLabels.length > 6) s.recentLabels.shift();
  feed(s, 'inst', orderFeedText(o));
  return true;
}

function addOrders(s: GameState, r: Rng) {
  const target = Math.min(3 + Math.floor(s.round / 8), 4);
  let guard = 0;
  while (s.orders.length < target && guard++ < 8) {
    const planted = !s.orders.some((x) => x.planted) && r.next() < 0.45;
    pushOrder(s, r, planted);
  }
}

// The anecdote made flesh: a resting broker walks his own quote — sometimes
// straight through fair, which is the arb you have to notice mid-life.
function improveOrder(s: GameState, r: Rng) {
  const candidates = s.orders.filter((o) => !o.planted);
  if (!candidates.length) return;
  const o = pick(r, candidates);
  const base = o.side === 'bid' ? closureBuyCost(s, o.product) : closureSellValue(s, o.product);
  let next: number | null = null;
  let throughFair = false;
  if (r.next() < 0.6 && base !== null) {
    const p = (1 + Math.floor(r.next() * 2)) * TICK;
    next = roundTick(o.side === 'bid' ? base + p : base - p);
    throughFair = true;
  }
  const improves = next !== null && (o.side === 'bid' ? next > o.price : next < o.price);
  if (!improves) {
    next = roundTick(o.side === 'bid' ? o.price + TICK : o.price - TICK);
    throughFair = false;
  }
  if (!o.product.over && next! < TICK) return;
  o.price = next!;
  if (throughFair) {
    o.planted = true;
    o.born = s.round; // the arb exists from the improvement, not the order
  }
  o.ttl = Math.max(o.ttl, 2);
  feed(s, 'inst', o.side === 'bid'
    ? `${o.broker} improves — ${fmtPx(o.product, o.price)} bid now for the ${o.product.label}!`
    : `${o.broker} improves — offers the ${o.product.label} at ${fmtPx(o.product, o.price)} now!`);
}

function expireOrder(s: GameState, o: RestingOrder) {
  const profit = orderArbProfit(s, o);
  s.orders = s.orders.filter((x) => x.id !== o.id);
  if (profit !== null && profit >= TICK - 0.001) {
    s.arbsSeen++;
    feed(s, 'game',
      `✗ Missed: ${o.broker}'s ${o.side === 'bid' ? 'bid' : 'offer'} on the ${o.product.label} was free money (+${profit.toFixed(2)}/lot on ${o.size} = ${usd(profit * o.size)}).`);
    s.decisions.push({
      round: s.round, label: o.product.label, action: 'let it expire',
      fair: fair(s.env, o.product), edge: 0,
      note: `missed arb ${usd(profit * o.size)}`,
    });
  }
}

function tryMM(s: GameState, r: Rng): boolean {
  const empties = emptyCells(s).filter(
    (c) => s.quotes[cellKey(c.m, c.K, c.right === 'C' ? 'P' : 'C')]
  );
  if (!empties.length) return false;
  const nearby = empties.filter((c) => Math.abs(c.K - s.env.spot) <= 10);
  const c = pick(r, nearby.length ? nearby : empties);
  const product = c.right === 'C' ? P.call(s.env, c.m, c.K) : P.put(s.env, c.m, c.K);
  s.mm = { product, fair: fair(s.env, product), ttl: 2 };
  feed(s, 'inst', `Make me a market in the ${product.label}.`);
  return true;
}

function lapseMM(s: GameState) {
  if (!s.mm) return;
  const leg = s.mm.product.legs[0] as Extract<P.Leg, { kind: 'opt' }>;
  const q = mkQuote(s.env, leg.m, leg.K, leg.right);
  s.quotes[singleCellKey(s.mm.product)] = q;
  s.decisions.push({
    round: s.round, label: s.mm.product.label, action: 'let the request lapse',
    fair: s.mm.fair, edge: 0, note: 'no market made',
  });
  feed(s, 'crowd', `Crowd makes it ${fmt(q.bid)} at ${fmt(q.ask)}.`);
  feed(s, 'game', `✗ No quote — the crowd made the market for you.`);
  s.mm = null;
}

// The bell: nothing stays open. A riskless book redeems at fair (it's a cash
// equivalent, same as the trade-out button); anything with risk on gets
// liquidated through the closure engine at real prices — crossing every
// spread is the cost of carrying risk into the close.
function closeAtTheBell(s: GameState) {
  if (isFlat(s)) return;
  if (isRiskless(s)) {
    for (const [key, q] of Object.entries(s.posOpt)) {
      const [m, K, right] = key.split('|');
      s.cash += q * optTheo(s.env, Number(m), Number(K), right as Right);
    }
    s.posOpt = {};
    s.cash += s.posStock * s.env.spot;
    s.posStock = 0;
    feed(s, 'game', `🔔 The bell. Your carry book redeems at fair.`);
    s.decisions.push({
      round: s.round, label: 'closing bell', action: 'carry redeemed at fair',
      fair: 0, edge: 0,
    });
    return;
  }
  let cost = 0; // liquidation cost vs theo marks
  for (const [key, q] of Object.entries(s.posOpt)) {
    const [m, K, right] = key.split('|') as [string, string, Right];
    const theo = optTheo(s.env, Number(m), Number(K), right);
    const px = (q > 0 ? bestSell(s, Number(m), Number(K), right) : bestBuy(s, Number(m), Number(K), right)) ?? theo;
    s.cash += q * px;
    cost += q * (px - theo);
  }
  s.posOpt = {};
  if (s.posStock) {
    const px = s.posStock > 0 ? stockBid(s.env) : stockAsk(s.env);
    s.cash += s.posStock * px;
    cost += s.posStock * (px - s.env.spot);
    s.posStock = 0;
  }
  feed(s, 'game', `🔔 The bell — you carried risk into the close: ${usd(cost)} to get flat at market.`);
  s.decisions.push({
    round: s.round, label: 'closing bell', action: 'forced flat at market',
    fair: 0, edge: cost, note: 'open risk at the close',
  });
}

function advanceTick(s: GameState, r: Rng) {
  s.round++;
  if (s.round > s.cfg.rounds) {
    for (const o of [...s.orders]) expireOrder(s, o);
    if (s.mm) lapseMM(s);
    closeAtTheBell(s);
    s.phase = 'debrief';
    return;
  }
  for (const o of [...s.orders]) {
    o.ttl -= 1;
    if (o.ttl <= 0) expireOrder(s, o);
  }
  if (s.mm) {
    s.mm.ttl -= 1;
    if (s.mm.ttl <= 0) lapseMM(s);
  }
  if (s.round > 2 && r.next() < 0.3) stockMove(s, r);
  if (emptyCells(s).length && r.next() < 0.4) crowdFill(s, r);
  if (!s.mm && r.next() < 0.35) tryMM(s, r);
  if (s.orders.length && r.next() < 0.25) improveOrder(s, r);
  addOrders(s, r);
}

// ---------------------------------------------------------------------------

// qty is a signed count: +10 buys ten, -5 sells five.
export function applyFill(s: GameState, product: Product, qty: number, price: number) {
  s.cash -= qty * price;
  for (const l of product.legs) {
    if (l.kind === 'opt') {
      const key = cellKey(l.m, l.K, l.right);
      s.posOpt[key] = (s.posOpt[key] ?? 0) + l.q * qty;
      if (s.posOpt[key] === 0) delete s.posOpt[key];
    } else if (l.kind === 'stock') s.posStock += l.q * qty;
    else s.banked += l.amt * qty;
  }
}

export function pnl(s: GameState): number {
  let v = s.cash + s.banked + s.posStock * s.env.spot;
  for (const [key, q] of Object.entries(s.posOpt)) {
    const [m, K, right] = key.split('|');
    v += q * optTheo(s.env, Number(m), Number(K), right as Right);
  }
  return v;
}

export function isFlat(s: GameState): boolean {
  return Object.keys(s.posOpt).length === 0 && s.posStock === 0;
}

// True when the book's expiry payoff is constant no matter where the stock
// settles — empty, or fully offset via conversions/reversals/boxes/rolls:
// calls and puts cancel at every strike and the residual synthetic stock is
// hedged share-for-share.
export function isRiskless(s: GameState): boolean {
  const perStrike: Record<string, { c: number; p: number }> = {};
  for (const [key, q] of Object.entries(s.posOpt)) {
    const [m, K, right] = key.split('|');
    const kk = `${m}|${K}`;
    perStrike[kk] ??= { c: 0, p: 0 };
    if (right === 'C') perStrike[kk].c += q;
    else perStrike[kk].p += q;
  }
  let synthStock = 0;
  for (const v of Object.values(perStrike)) {
    if (v.c + v.p !== 0) return false;
    synthStock += v.c;
  }
  return s.posStock + synthStock === 0;
}

export function netDelta(s: GameState): number {
  let d = s.posStock;
  for (const [key, q] of Object.entries(s.posOpt)) {
    const [m, K, right] = key.split('|');
    d += q * optDelta(s.env, Number(m), Number(K), right as Right);
  }
  return d;
}

// The trader's view of the book: long-call/short-put overlap at each strike
// collapses into combos; residual legs and stock follow. Row keys are stable
// so the UI can select rows for manual netting.
export type BookRow = { key: string; label: string; qty: number };

export function bookRows(s: GameState): BookRow[] {
  const byStrike: Record<string, { c: number; p: number }> = {};
  for (const [key, q] of Object.entries(s.posOpt)) {
    const [m, K, right] = key.split('|');
    const kk = `${m}|${K}`;
    byStrike[kk] ??= { c: 0, p: 0 };
    if (right === 'C') byStrike[kk].c += q;
    else byStrike[kk].p += q;
  }
  const rows: BookRow[] = [];
  for (const kk of Object.keys(byStrike).sort()) {
    const [m, K] = kk.split('|');
    const { c, p } = byStrike[kk];
    const name = `${s.env.months[Number(m)]} ${K}`;
    let combos = 0;
    if (c > 0 && p < 0) combos = Math.min(c, -p);
    else if (c < 0 && p > 0) combos = -Math.min(-c, p);
    if (combos) rows.push({ key: `combo|${kk}`, label: `${name} combo`, qty: combos });
    if (c - combos) rows.push({ key: `opt|${kk}|C`, label: `${name}C`, qty: c - combos });
    if (p + combos) rows.push({ key: `opt|${kk}|P`, label: `${name}P`, qty: p + combos });
  }
  if (s.posStock) rows.push({ key: 'stock', label: 'stock', qty: s.posStock });
  return rows;
}

function afterFill(s: GameState) {
  if (isFlat(s)) {
    if (Math.abs(s.cash + s.banked) > 0.001)
      feed(s, 'game', `🔒 Book flat — ${usd(s.cash + s.banked)} locked in, no risk on.`);
    return;
  }
  if (isRiskless(s)) {
    feed(s, 'game', `🔒 Book locked — the legs offset, ${usd(pnl(s))} riskless.`);
    return;
  }
  const d = netDelta(s);
  if (Math.abs(d) >= 0.4)
    feed(s, 'game',
      `Net delta ≈ ${signed(d)} — stock is ${fmt(stockBid(s.env))} @ ${fmt(stockAsk(s.env))} if you want to flatten.`);
}

// Board markets are only accurate to about a tick, so a sub-tick per-lot
// result is judged as noise, not as a mistake. edge is the total; size scales
// the thresholds back to per-lot terms.
function judgeTrade(s: GameState, edge: number, size = 1) {
  const perLot = edge / size;
  if (perLot >= TICK - 0.001) feed(s, 'game', `✓ Good trade: ${usd(edge)} vs fair.`);
  else if (perLot <= -(TICK - 0.001)) feed(s, 'game', `✗ Through fair: ${usd(edge)}.`);
  else if (Math.abs(perLot) <= EPS) feed(s, 'game', `— Scratch. That was right at fair.`);
  else feed(s, 'game', `— About fair (${usd(edge)}) — inside the board's noise.`);
}

export function newSession(cfg: SessionConfig): GameState {
  if (!cfg.products?.length) cfg = { ...cfg, products: PRODUCT_SETS.medium };
  const r = mulberry32(cfg.seed || 1);
  const env = makeEnv(r, cfg.twoExp);
  const s: GameState = {
    cfg, env, rng: 0, quotes: {}, round: 0, orders: [], mm: null, nextId: 1,
    arbsSeen: 0, arbsCaptured: 0, captureTicks: [], recentLabels: [], feed: [], decisions: [],
    posOpt: {}, posStock: 0, cash: 0, banked: 0, phase: 'playing',
  };
  for (let i = 0; i < 3; i++) crowdFill(s, r, false);
  feed(s, 'game', `Pit open. Stock ${fmt(stockBid(env))} @ ${fmt(stockAsk(env))}, r/c ${env.rc.map(fmt).join(' / ')}.`);
  advanceTick(s, r);
  s.rng = r.state;
  return s;
}

export function reduce(prev: GameState, a: Action): GameState {
  if (prev.phase !== 'playing') return prev;
  const s = structuredClone(prev);
  const r = mulberry32(s.rng);

  switch (a.type) {
    case 'tick': {
      advanceTick(s, r);
      break;
    }
    case 'order': {
      const o = s.orders.find((x) => x.id === a.id);
      if (!o) break;
      const cp = orderArbProfit(s, o);
      const dir = o.side === 'ask' ? 1 : -1;
      applyFill(s, o.product, dir * o.size, o.price);
      s.orders = s.orders.filter((x) => x.id !== o.id);
      const f = fair(s.env, o.product);
      const edge = (dir === 1 ? f - o.price : o.price - f) * o.size;
      const isArb = cp !== null && cp >= TICK - 0.001;
      if (isArb) {
        s.arbsSeen++;
        s.arbsCaptured++;
        s.captureTicks.push(Math.max(0, s.round - o.born));
        feed(s, 'game',
          `✓ Arb: the legs close for ${signed(cp!)}/lot riskless (${usd(cp! * o.size)} on ${o.size}) — flatten it.`);
      }
      s.decisions.push({
        round: s.round, label: o.product.label,
        action: `${dir === 1 ? 'bought' : 'sold'} ${o.size} at ${fmtPx(o.product, o.price)} (${o.broker})`,
        fair: f, edge, note: isArb ? `arb ${usd(cp! * o.size)} available` : undefined,
      });
      feed(s, 'you',
        `You ${dir === 1 ? 'bought' : 'sold'} the ${o.product.label} ×${o.size} at ${fmtPx(o.product, o.price)}.`);
      if (!isArb) judgeTrade(s, edge, o.size);
      afterFill(s);
      break;
    }
    case 'mm': {
      if (!s.mm) break;
      const { bid, ask } = a;
      const f = s.mm.fair;
      const product = s.mm.product;
      const eps = TICK / 2;
      const key = singleCellKey(product);
      const leg = product.legs[0] as Extract<P.Leg, { kind: 'opt' }>;
      let edge = 0;
      let note: string | undefined;
      if (bid > f + eps) {
        const sz = pick(r, [5, 10, 20]);
        applyFill(s, product, sz, bid);
        edge = (f - bid) * sz;
        note = 'picked off on your bid';
        feed(s, 'inst', `"Sold to you at ${fmt(bid)}, ${sz} up!"`);
        const q = mkQuote(s.env, leg.m, leg.K, leg.right);
        s.quotes[key] = q;
        feed(s, 'crowd', `Crowd corrects it to ${fmt(q.bid)} at ${fmt(q.ask)}.`);
        feed(s, 'game', `✗ Picked off: ${usd(edge)}. Your bid was through fair.`);
      } else if (ask < f - eps) {
        const sz = pick(r, [5, 10, 20]);
        applyFill(s, product, -sz, ask);
        edge = (ask - f) * sz;
        note = 'picked off on your offer';
        feed(s, 'inst', `"Mine at ${fmt(ask)}, ${sz} up!"`);
        const q = mkQuote(s.env, leg.m, leg.K, leg.right);
        s.quotes[key] = q;
        feed(s, 'crowd', `Crowd corrects it to ${fmt(q.bid)} at ${fmt(q.ask)}.`);
        feed(s, 'game', `✗ Picked off: ${usd(edge)}. Your offer was through fair.`);
      } else {
        s.quotes[key] = { bid, ask }; // your market is now the market
        if (r.next() < 0.5) {
          const sz = pick(r, [5, 10, 20]);
          if (r.next() < 0.5) {
            applyFill(s, product, -sz, ask);
            edge = (ask - f) * sz;
            feed(s, 'inst', `He lifts your offer at ${fmt(ask)}, ${sz} up.`);
          } else {
            applyFill(s, product, sz, bid);
            edge = (f - bid) * sz;
            feed(s, 'inst', `He hits your bid at ${fmt(bid)}, ${sz} up.`);
          }
          note = 'inventory from your market';
          feed(s, 'game', `✓ Market held: ${usd(edge)} earned at your price — inventory to manage.`);
        } else {
          feed(s, 'inst', `"Fair enough." Your market stands on the board.`);
          feed(s, 'game', `✓ Market held — fair was inside your quote.`);
        }
      }
      if (ask - bid > 0.45) note = note ? `${note}; wide market` : 'wide market';
      s.decisions.push({
        round: s.round, label: product.label,
        action: `quoted ${fmt(bid)}–${fmt(ask)}`, fair: f, edge, note,
      });
      s.mm = null;
      afterFill(s);
      break;
    }
    case 'pass': {
      if (!s.mm) break;
      const leg = s.mm.product.legs[0] as Extract<P.Leg, { kind: 'opt' }>;
      const q = mkQuote(s.env, leg.m, leg.K, leg.right);
      s.quotes[singleCellKey(s.mm.product)] = q;
      s.decisions.push({
        round: s.round, label: s.mm.product.label, action: 'declined to quote',
        fair: s.mm.fair, edge: 0, note: 'no market made',
      });
      feed(s, 'crowd', `Crowd makes it ${fmt(q.bid)} at ${fmt(q.ask)}.`);
      feed(s, 'game', `✗ No quote — the crowd made the market for you.`);
      s.mm = null;
      break;
    }
    case 'board': {
      const q = s.quotes[cellKey(a.m, a.K, a.right)];
      if (!q) break;
      const size = Math.max(1, Math.round(a.size ?? 1));
      const product = a.right === 'C' ? P.call(s.env, a.m, a.K) : P.put(s.env, a.m, a.K);
      const dir = a.side === 'ask' ? 1 : -1;
      const price = a.side === 'ask' ? q.ask : q.bid;
      const f = fair(s.env, product);
      applyFill(s, product, dir * size, price);
      s.decisions.push({
        round: s.round, label: product.label,
        action: `${dir === 1 ? 'bought' : 'sold'} ${size} at ${fmt(price)} on the board`,
        fair: f, edge: (dir === 1 ? f - price : price - f) * size, note: 'board trade',
      });
      feed(s, 'you', `You ${dir === 1 ? 'bought' : 'sold'} the ${product.label} ×${size} at ${fmt(price)} on the board.`);
      afterFill(s);
      break;
    }
    case 'net': {
      // Manual netting: the player picks position rows they believe offset.
      // If the selected legs form a constant payoff, they settle at fair and
      // leave the book — never automatic, always the player's read.
      const rows = bookRows(s).filter((row) => a.keys.includes(row.key));
      const optRows = rows.filter((row) => row.key !== 'stock');
      if (!optRows.length) break;
      const stockSel = rows.some((row) => row.key === 'stock');
      const legs: Record<string, number> = {};
      for (const row of optRows) {
        const [kind, m, K, right] = row.key.split('|');
        if (kind === 'combo') {
          legs[`${m}|${K}|C`] = (legs[`${m}|${K}|C`] ?? 0) + row.qty;
          legs[`${m}|${K}|P`] = (legs[`${m}|${K}|P`] ?? 0) - row.qty;
        } else {
          legs[`${m}|${K}|${right}`] = (legs[`${m}|${K}|${right}`] ?? 0) + row.qty;
        }
      }
      const perStrike: Record<string, { c: number; p: number }> = {};
      for (const [key, q] of Object.entries(legs)) {
        const [m, K, right] = key.split('|');
        const kk = `${m}|${K}`;
        perStrike[kk] ??= { c: 0, p: 0 };
        if (right === 'C') perStrike[kk].c += q;
        else perStrike[kk].p += q;
      }
      const kinked = Object.entries(perStrike).find(([, v]) => v.c + v.p !== 0);
      if (kinked) {
        const [m, K] = kinked[0].split('|');
        feed(s, 'game',
          `✗ Not flat — the ${s.env.months[Number(m)]} ${K} strike still kinks: calls and puts don't offset there.`);
        break;
      }
      const slope = Object.values(perStrike).reduce((acc, v) => acc + v.c, 0);
      let stockUsed = 0;
      if (stockSel) {
        if (slope === 0) {
          feed(s, 'game', `✗ Those option legs already offset by themselves — the stock isn't part of that cancel.`);
          break;
        }
        stockUsed = -slope;
        if (Math.sign(stockUsed) !== Math.sign(s.posStock) || Math.abs(stockUsed) > Math.abs(s.posStock)) {
          feed(s, 'game',
            `✗ You'd need ${stockUsed > 0 ? '+' : ''}${stockUsed} stock to flatten those legs — you hold ${s.posStock > 0 ? '+' : ''}${s.posStock}.`);
          break;
        }
      } else if (slope !== 0) {
        feed(s, 'game',
          `✗ Not flat — still net ${slope > 0 ? 'long' : 'short'} ${Math.abs(slope)} synthetic stock. Select stock to complete the cancel.`);
        break;
      }
      for (const [key, q] of Object.entries(legs)) {
        const [m, K, right] = key.split('|');
        s.cash += q * optTheo(s.env, Number(m), Number(K), right as Right);
        s.posOpt[key] = (s.posOpt[key] ?? 0) - q;
        if (s.posOpt[key] === 0) delete s.posOpt[key];
      }
      s.cash += stockUsed * s.env.spot;
      s.posStock -= stockUsed;
      const what = optRows.map((row) => `${row.qty > 0 ? '+' : ''}${row.qty} ${row.label}`).join(', ');
      feed(s, 'game',
        `🔒 Netted off at fair: ${what}${stockUsed ? ` vs ${Math.abs(stockUsed)} stock` : ''}.`);
      s.decisions.push({
        round: s.round, label: 'book netting', action: `cancelled out ${what}`,
        fair: 0, edge: 0, note: 'riskless subset settled at fair',
      });
      afterFill(s);
      break;
    }
    case 'unwind': {
      // A riskless book is a cash equivalent — long the r/c and nothing else —
      // so it redeems at fair, no spreads to cross. Never allowed with risk on.
      if (isFlat(s) || !isRiskless(s)) break;
      for (const [key, q] of Object.entries(s.posOpt)) {
        const [m, K, right] = key.split('|');
        s.cash += q * optTheo(s.env, Number(m), Number(K), right as Right);
      }
      s.posOpt = {};
      s.cash += s.posStock * s.env.spot;
      s.posStock = 0;
      s.decisions.push({
        round: s.round, label: 'carry book', action: 'traded out at fair',
        fair: 0, edge: 0, note: 'riskless unwind',
      });
      feed(s, 'you', `You trade out of the carry at fair.`);
      afterFill(s);
      break;
    }
    case 'stock': {
      const size = Math.max(1, Math.round(a.size ?? 1));
      const price = a.side === 'ask' ? stockAsk(s.env) : stockBid(s.env);
      const dir = a.side === 'ask' ? 1 : -1;
      s.posStock += dir * size;
      s.cash -= dir * size * price;
      s.decisions.push({
        round: s.round, label: 'stock',
        action: `${dir === 1 ? 'bought' : 'sold'} ${size} at ${fmt(price)}`,
        fair: s.env.spot, edge: (dir === 1 ? s.env.spot - price : price - s.env.spot) * size,
        note: 'stock trade',
      });
      feed(s, 'you', `You ${dir === 1 ? 'bought' : 'sold'} ${size} stock at ${fmt(price)}.`);
      afterFill(s);
      break;
    }
  }

  s.rng = r.state;
  return s;
}

export { legsText, fmtPx, fair };
