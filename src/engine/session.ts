import { Rng, mulberry32, pick, normal } from './rng';
import {
  Env, Right, makeEnv, optTheo, optDelta, roundTick, TICK, fmt, strikeSkew,
  stockBid, stockAsk,
} from './market';
import * as P from './products';
import { Product, fair, fmtPx, legsText } from './products';

export type Noise = 0 | 1 | 2;

export type SessionConfig = {
  seed: number;
  rounds: number; // ticks of pit time
  noise: Noise;
  twoExp: boolean;
  shotClock: number; // seconds per tick, 0 = advance manually
};

// A live order resting in the pit. side is the broker's side: a 'bid' order
// means the broker pays that price (you can sell to him).
export type RestingOrder = {
  id: number;
  broker: string;
  product: Product;
  side: 'bid' | 'ask';
  price: number;
  ttl: number; // ticks until the broker pulls it
  planted: boolean; // constructed to be arbitrage-able (for debrief stats)
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
  | { type: 'board'; m: number; K: number; right: Right; side: 'bid' | 'ask' }
  | { type: 'stock'; side: 'bid' | 'ask' };

export const cellKey = (m: number, K: number, right: Right) => `${m}|${K}|${right}`;

const EPS = 0.011;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

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

function phaseKinds(s: GameState): string[] {
  const frac = s.round / s.cfg.rounds;
  if (frac <= 0.35) return ['call', 'put', 'bw', 'pns'];
  if (frac <= 0.7) return ['straddle', 'strangle', 'callSpread', 'putSpread', 'call', 'put', 'bw'];
  const kinds = ['fly', 'ironFly', 'box', 'rr', 'straddle', 'strangle'];
  if (s.cfg.twoExp) kinds.push('roll', 'roll');
  return kinds;
}

function mkOrderProduct(s: GameState, r: Rng): { product: Product; f: number } | null {
  const kinds = phaseKinds(s);
  for (let tries = 0; tries < 25; tries++) {
    const product = buildProduct(s, r, pick(r, kinds));
    if (!product) continue;
    if (!productAnchored(s, product)) continue;
    const f = fair(s.env, product);
    if (!product.over && f < 0.15) continue;
    return { product, f };
  }
  return null;
}

function orderFeedText(o: RestingOrder): string {
  return o.side === 'bid'
    ? `${o.broker} pays ${fmtPx(o.product, o.price)} for the ${o.product.label}.`
    : `${o.broker} offers the ${o.product.label} at ${fmtPx(o.product, o.price)}.`;
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
    ttl: 2 + Math.floor(r.next() * (planted ? 2 : 3)), planted,
  };
  s.orders.push(o);
  feed(s, 'inst', orderFeedText(o));
  return true;
}

function addOrders(s: GameState, r: Rng) {
  const target = Math.min(2 + Math.floor(s.round / 5), 4);
  let guard = 0;
  while (s.orders.length < target && guard++ < 8) {
    const planted = !s.orders.some((x) => x.planted) && r.next() < 0.45;
    pushOrder(s, r, planted);
  }
}

function expireOrder(s: GameState, o: RestingOrder) {
  const profit = orderArbProfit(s, o);
  s.orders = s.orders.filter((x) => x.id !== o.id);
  if (profit !== null && profit >= TICK - 0.001) {
    s.arbsSeen++;
    feed(s, 'game',
      `✗ Missed: ${o.broker}'s ${o.side === 'bid' ? 'bid' : 'offer'} on the ${o.product.label} was free money (+${profit.toFixed(2)}).`);
    s.decisions.push({
      round: s.round, label: o.product.label, action: 'let it expire',
      fair: fair(s.env, o.product), edge: 0, note: `missed arb +${profit.toFixed(2)}`,
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

function advanceTick(s: GameState, r: Rng) {
  s.round++;
  if (s.round > s.cfg.rounds) {
    for (const o of [...s.orders]) expireOrder(s, o);
    if (s.mm) lapseMM(s);
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
  addOrders(s, r);
}

// ---------------------------------------------------------------------------

export function applyFill(s: GameState, product: Product, qty: 1 | -1, price: number) {
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

function afterFill(s: GameState) {
  if (isFlat(s)) {
    if (Math.abs(s.cash + s.banked) > 0.001)
      feed(s, 'game', `🔒 Book flat — ${signed(s.cash + s.banked)} locked in, no risk on.`);
    return;
  }
  if (isRiskless(s)) {
    feed(s, 'game', `🔒 Book locked — the legs offset, ${signed(pnl(s))} riskless.`);
    return;
  }
  const d = netDelta(s);
  if (Math.abs(d) >= 0.4)
    feed(s, 'game',
      `Net delta ≈ ${signed(d)} — stock is ${fmt(stockBid(s.env))} @ ${fmt(stockAsk(s.env))} if you want to flatten.`);
}

// Board markets are only accurate to about a tick, so a sub-tick result is
// judged as noise, not as a mistake.
function judgeTrade(s: GameState, edge: number) {
  if (edge >= TICK - 0.001) feed(s, 'game', `✓ Good trade: ${signed(edge)} vs fair.`);
  else if (edge <= -(TICK - 0.001)) feed(s, 'game', `✗ Through fair: ${signed(edge)}.`);
  else if (Math.abs(edge) <= EPS) feed(s, 'game', `— Scratch. That was right at fair.`);
  else feed(s, 'game', `— About fair (${signed(edge)}) — inside the board's noise.`);
}

export function newSession(cfg: SessionConfig): GameState {
  const r = mulberry32(cfg.seed || 1);
  const env = makeEnv(r, cfg.twoExp);
  const s: GameState = {
    cfg, env, rng: 0, quotes: {}, round: 0, orders: [], mm: null, nextId: 1,
    arbsSeen: 0, arbsCaptured: 0, feed: [], decisions: [],
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
      const qty: 1 | -1 = o.side === 'ask' ? 1 : -1;
      applyFill(s, o.product, qty, o.price);
      s.orders = s.orders.filter((x) => x.id !== o.id);
      const f = fair(s.env, o.product);
      const edge = qty === 1 ? f - o.price : o.price - f;
      const isArb = cp !== null && cp >= TICK - 0.001;
      if (isArb) {
        s.arbsSeen++;
        s.arbsCaptured++;
        feed(s, 'game', `✓ Arb: the legs close for ${signed(cp!)} riskless — flatten it.`);
      }
      s.decisions.push({
        round: s.round, label: o.product.label,
        action: `${qty === 1 ? 'bought' : 'sold'} at ${fmtPx(o.product, o.price)} (${o.broker})`,
        fair: f, edge, note: isArb ? `arb +${cp!.toFixed(2)} available` : undefined,
      });
      feed(s, 'you', `You ${qty === 1 ? 'bought' : 'sold'} the ${o.product.label} at ${fmtPx(o.product, o.price)}.`);
      if (!isArb) judgeTrade(s, edge);
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
        applyFill(s, product, 1, bid);
        edge = f - bid;
        note = 'picked off on your bid';
        feed(s, 'inst', `"Sold to you at ${fmt(bid)}!"`);
        const q = mkQuote(s.env, leg.m, leg.K, leg.right);
        s.quotes[key] = q;
        feed(s, 'crowd', `Crowd corrects it to ${fmt(q.bid)} at ${fmt(q.ask)}.`);
        feed(s, 'game', `✗ Picked off: ${signed(edge)}. Your bid was through fair.`);
      } else if (ask < f - eps) {
        applyFill(s, product, -1, ask);
        edge = ask - f;
        note = 'picked off on your offer';
        feed(s, 'inst', `"Mine at ${fmt(ask)}!"`);
        const q = mkQuote(s.env, leg.m, leg.K, leg.right);
        s.quotes[key] = q;
        feed(s, 'crowd', `Crowd corrects it to ${fmt(q.bid)} at ${fmt(q.ask)}.`);
        feed(s, 'game', `✗ Picked off: ${signed(edge)}. Your offer was through fair.`);
      } else {
        s.quotes[key] = { bid, ask }; // your market is now the market
        if (r.next() < 0.5) {
          if (r.next() < 0.5) {
            applyFill(s, product, -1, ask);
            edge = ask - f;
            feed(s, 'inst', `He lifts your offer at ${fmt(ask)}.`);
          } else {
            applyFill(s, product, 1, bid);
            edge = f - bid;
            feed(s, 'inst', `He hits your bid at ${fmt(bid)}.`);
          }
          feed(s, 'game', `✓ Market held: ${signed(edge)} earned at your price.`);
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
      const product = a.right === 'C' ? P.call(s.env, a.m, a.K) : P.put(s.env, a.m, a.K);
      const qty: 1 | -1 = a.side === 'ask' ? 1 : -1;
      const price = a.side === 'ask' ? q.ask : q.bid;
      const f = fair(s.env, product);
      applyFill(s, product, qty, price);
      s.decisions.push({
        round: s.round, label: product.label,
        action: `${qty === 1 ? 'bought' : 'sold'} at ${fmt(price)} on the board`,
        fair: f, edge: qty === 1 ? f - price : price - f, note: 'board trade',
      });
      feed(s, 'you', `You ${qty === 1 ? 'bought' : 'sold'} the ${product.label} at ${fmt(price)} on the board.`);
      afterFill(s);
      break;
    }
    case 'stock': {
      const price = a.side === 'ask' ? stockAsk(s.env) : stockBid(s.env);
      const qty: 1 | -1 = a.side === 'ask' ? 1 : -1;
      s.posStock += qty;
      s.cash -= qty * price;
      s.decisions.push({
        round: s.round, label: 'stock',
        action: `${qty === 1 ? 'bought' : 'sold'} at ${fmt(price)}`,
        fair: s.env.spot, edge: qty === 1 ? s.env.spot - price : price - s.env.spot,
        note: 'stock trade',
      });
      feed(s, 'you', `You ${qty === 1 ? 'bought' : 'sold'} stock at ${fmt(price)}.`);
      afterFill(s);
      break;
    }
  }

  s.rng = r.state;
  return s;
}

export { legsText, fmtPx, fair };
