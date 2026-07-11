import { Rng, mulberry32, pick, normal } from './rng';
import {
  Env, Right, makeEnv, optTheo, optDelta, roundTick, TICK, fmt,
  stockBid, stockAsk,
} from './market';
import * as P from './products';
import { Product, fair, fmtPx, legsText } from './products';

export type Noise = 0 | 1 | 2;

export type SessionConfig = {
  seed: number;
  rounds: number;
  noise: Noise;
  twoExp: boolean;
  shotClock: number; // seconds, 0 = untimed
};

export type Pending =
  | { kind: 'take'; product: Product; side: 'bid' | 'ask'; price: number; fair: number }
  | { kind: 'mm'; product: Product; fair: number };

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
  pending: Pending | null;
  feed: FeedItem[];
  decisions: Decision[];
  posOpt: Record<string, number>;
  posStock: number;
  cash: number;
  banked: number; // face value banked to expiry from vs-strike packages
  phase: 'playing' | 'debrief';
};

export type Action =
  | { type: 'take' }
  | { type: 'leave'; timeout?: boolean }
  | { type: 'mm'; bid: number; ask: number }
  | { type: 'pass'; timeout?: boolean }
  | { type: 'board'; m: number; K: number; right: Right; side: 'bid' | 'ask' }
  | { type: 'stock'; side: 'bid' | 'ask' };

export const cellKey = (m: number, K: number, right: Right) => `${m}|${K}|${right}`;

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

function mkQuote(env: Env, r: Rng, m: number, K: number, right: Right): Quote {
  const t = optTheo(env, m, K, right);
  const w = t >= 1.5 ? 0.2 : 0.1;
  const skew = (Math.floor(r.next() * 3) - 1) * TICK;
  const bid = Math.max(0, roundTick(t - w / 2 + skew));
  return { bid, ask: roundTick(bid + w) };
}

function crowdFill(s: GameState, r: Rng, announce = true) {
  const empties = emptyCells(s);
  if (!empties.length) return;
  const nearby = empties.filter((c) => Math.abs(c.K - s.env.spot) <= 10);
  const c = pick(r, nearby.length ? nearby : empties);
  const q = mkQuote(s.env, r, c.m, c.K, c.right);
  s.quotes[cellKey(c.m, c.K, c.right)] = q;
  if (announce)
    feed(s, 'crowd',
      `Crowd makes ${fmt(q.bid)} at ${fmt(q.ask)} on the ${s.env.months[c.m]} ${c.K} ${c.right === 'C' ? 'calls' : 'puts'}.`);
}

function stockMove(s: GameState, r: Rng) {
  let d = roundTick(Math.max(-1, Math.min(1, normal(r) * 0.35)));
  if (d === 0) return;
  s.env = { ...s.env, spot: roundTick(s.env.spot + d) };
  for (const key of Object.keys(s.quotes)) {
    const [m, K, right] = key.split('|');
    s.quotes[key] = mkQuote(s.env, r, Number(m), Number(K), right as Right);
  }
  feed(s, 'game',
    `Stock ${d > 0 ? 'ticks up' : 'ticks down'} to ${fmt(stockBid(s.env))} @ ${fmt(stockAsk(s.env))} — crowd refreshes its markets.`);
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

const MM_KINDS = ['call', 'put', 'straddle', 'strangle', 'callSpread', 'putSpread', 'fly'];

function makePending(s: GameState, r: Rng) {
  const frac = s.round / s.cfg.rounds;
  let kinds: string[];
  if (frac <= 0.35) kinds = ['call', 'put', 'bw', 'pns'];
  else if (frac <= 0.7) kinds = ['straddle', 'strangle', 'callSpread', 'putSpread', 'call', 'put', 'bw'];
  else {
    kinds = ['fly', 'ironFly', 'box', 'rr', 'straddle', 'strangle'];
    if (s.cfg.twoExp) kinds.push('roll', 'roll');
  }
  for (let tries = 0; tries < 15; tries++) {
    const kind = pick(r, kinds);
    const product = buildProduct(s, r, kind);
    if (!product) continue;
    const f = fair(s.env, product);
    if (!product.over && f < 0.15) continue;
    if (MM_KINDS.includes(kind) && r.next() < 0.3) {
      s.pending = { kind: 'mm', product, fair: f };
      feed(s, 'inst', `Make me a market in the ${product.label}.`);
      return;
    }
    const side: 'bid' | 'ask' = r.next() < 0.5 ? 'bid' : 'ask';
    const price = instPrice(s, r, f, side);
    if (!product.over && price < TICK) continue;
    s.pending = { kind: 'take', product, side, price, fair: f };
    feed(s, 'inst', side === 'bid'
      ? `I'm ${fmtPx(product, price)} bid for the ${product.label}.`
      : `I'll sell the ${product.label} at ${fmtPx(product, price)}.`);
    return;
  }
  const atm = s.env.strikes[2];
  const product = P.straddle(s.env, 0, atm);
  const f = fair(s.env, product);
  const price = instPrice(s, r, f, 'bid');
  s.pending = { kind: 'take', product, side: 'bid', price, fair: f };
  feed(s, 'inst', `I'm ${fmt(price)} bid for the ${product.label}.`);
}

function advance(s: GameState, r: Rng) {
  s.round++;
  if (s.round > s.cfg.rounds) {
    s.phase = 'debrief';
    s.pending = null;
    return;
  }
  if (s.round > 2 && r.next() < 0.3) stockMove(s, r);
  if (emptyCells(s).length && r.next() < 0.75) {
    crowdFill(s, r);
    if (r.next() < 0.35) crowdFill(s, r);
  }
  makePending(s, r);
}

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

// The single score: position marked to hidden theos, plus cash. Includes every
// spread you crossed to hedge and every move against open positions.
export function pnl(s: GameState): number {
  let v = s.cash + s.banked + s.posStock * s.env.spot;
  for (const [key, q] of Object.entries(s.posOpt)) {
    const [m, K, right] = key.split('|');
    v += q * optTheo(s.env, Number(m), Number(K), right as Right);
  }
  return v;
}

export function netDelta(s: GameState): number {
  let d = s.posStock;
  for (const [key, q] of Object.entries(s.posOpt)) {
    const [m, K, right] = key.split('|');
    d += q * optDelta(s.env, Number(m), Number(K), right as Right);
  }
  return d;
}

function hedgeHint(s: GameState) {
  const d = netDelta(s);
  if (Math.abs(d) >= 0.4)
    feed(s, 'game',
      `Net delta ≈ ${d > 0 ? '+' : ''}${d.toFixed(2)} — stock is ${fmt(stockBid(s.env))} @ ${fmt(stockAsk(s.env))} if you want to flatten.`);
}

function instReaction(s: GameState, r: Rng, edge: number) {
  if (edge > 0.01) feed(s, 'inst', pick(r, [`He winces. "Nice trade."`, `"Hm. Sharper than you look."`]));
  else if (edge < -0.01) feed(s, 'inst', pick(r, [`He grins. "Thank you!"`, `"Pleasure doing business."`]));
  else feed(s, 'inst', `"Scratch." He shrugs.`);
}

export function newSession(cfg: SessionConfig): GameState {
  const r = mulberry32(cfg.seed || 1);
  const env = makeEnv(r, cfg.twoExp);
  const s: GameState = {
    cfg, env, rng: 0, quotes: {}, round: 0, pending: null, feed: [], decisions: [],
    posOpt: {}, posStock: 0, cash: 0, banked: 0, phase: 'playing',
  };
  for (let i = 0; i < 3; i++) crowdFill(s, r, false);
  feed(s, 'game', `Session open. Stock ${fmt(stockBid(env))} @ ${fmt(stockAsk(env))}, r/c ${env.rc.map(fmt).join(' / ')}.`);
  advance(s, r);
  s.rng = r.state;
  return s;
}

export function reduce(prev: GameState, a: Action): GameState {
  if (prev.phase !== 'playing') return prev;
  const s = structuredClone(prev);
  const r = mulberry32(s.rng);
  const pd = s.pending;

  switch (a.type) {
    case 'take': {
      if (!pd || pd.kind !== 'take') break;
      const qty: 1 | -1 = pd.side === 'ask' ? 1 : -1; // buy their offer / sell to their bid
      applyFill(s, pd.product, qty, pd.price);
      const edge = qty === 1 ? pd.fair - pd.price : pd.price - pd.fair;
      s.decisions.push({
        round: s.round, label: pd.product.label,
        action: `${qty === 1 ? 'bought' : 'sold'} at ${fmtPx(pd.product, pd.price)}`,
        fair: pd.fair, edge,
      });
      feed(s, 'you', `You ${qty === 1 ? 'bought' : 'sold'} the ${pd.product.label} at ${fmtPx(pd.product, pd.price)}.`);
      instReaction(s, r, edge);
      hedgeHint(s);
      advance(s, r);
      break;
    }
    case 'leave': {
      if (!pd || pd.kind !== 'take') break;
      const avail = pd.side === 'bid' ? pd.price - pd.fair : pd.fair - pd.price;
      s.decisions.push({
        round: s.round, label: pd.product.label,
        action: a.timeout ? 'let it go (clock ran out)' : 'left it',
        fair: pd.fair, edge: 0,
        note: avail > TICK / 2 ? `missed +${avail.toFixed(2)}` : undefined,
      });
      if (avail > TICK / 2 && r.next() < 0.6)
        feed(s, 'crowd', pd.side === 'bid'
          ? `Crowd hits him at ${fmtPx(pd.product, pd.price)}.`
          : `Crowd lifts him at ${fmtPx(pd.product, pd.price)}.`);
      advance(s, r);
      break;
    }
    case 'mm': {
      if (!pd || pd.kind !== 'mm') break;
      const { bid, ask } = a;
      const f = pd.fair;
      const eps = TICK / 2;
      let edge = 0;
      let note: string | undefined;
      if (bid > f + eps) {
        applyFill(s, pd.product, 1, bid);
        edge = f - bid;
        note = 'picked off on your bid';
        feed(s, 'inst', `"Sold to you at ${fmt(bid)}!"`);
      } else if (ask < f - eps) {
        applyFill(s, pd.product, -1, ask);
        edge = ask - f;
        note = 'picked off on your offer';
        feed(s, 'inst', `"Mine at ${fmt(ask)}!"`);
      } else if (r.next() < 0.5) {
        if (r.next() < 0.5) {
          applyFill(s, pd.product, -1, ask);
          edge = ask - f;
          feed(s, 'inst', `He lifts your offer at ${fmt(ask)}.`);
        } else {
          applyFill(s, pd.product, 1, bid);
          edge = f - bid;
          feed(s, 'inst', `He hits your bid at ${fmt(bid)}.`);
        }
      } else {
        feed(s, 'inst', `"Fair market." He moves on.`);
      }
      if (ask - bid > 0.45) note = note ? `${note}; wide market` : 'wide market';
      s.decisions.push({
        round: s.round, label: pd.product.label,
        action: `quoted ${fmt(bid)}–${fmt(ask)}`, fair: f, edge, note,
      });
      hedgeHint(s);
      advance(s, r);
      break;
    }
    case 'pass': {
      if (!pd || pd.kind !== 'mm') break;
      s.decisions.push({
        round: s.round, label: pd.product.label,
        action: a.timeout ? 'froze (clock ran out)' : 'declined to quote',
        fair: pd.fair, edge: 0, note: 'no market made',
      });
      feed(s, 'inst', `"You'll have to make a market eventually."`);
      advance(s, r);
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
      break; // board trades don't consume the round
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
      break;
    }
  }

  s.rng = r.state;
  return s;
}

export { legsText, fmtPx, fair };
