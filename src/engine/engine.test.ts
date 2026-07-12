import { describe, it, expect } from 'vitest';
import { mulberry32 } from './rng';
import { makeEnv, optTheo, fwd, TICK, roundTick } from './market';
import * as P from './products';
import { fair, fmtPx } from './products';
import {
  newSession, reduce, applyFill, pnl, isFlat, isRiskless, GameState, SessionConfig, RestingOrder, PRODUCT_SETS,
  bestBuy, bestSell, closureBuyCost, closureSellValue, orderArbProfit,
} from './session';
import { makeDrill } from './drill';

const env1 = makeEnv(mulberry32(42), false);
const env2 = makeEnv(mulberry32(42), true);

describe('put-call parity: C - P = (S - K) + r/c', () => {
  it('holds at every strike and month', () => {
    for (const env of [env1, env2]) {
      for (let m = 0; m < env.months.length; m++) {
        for (const K of env.strikes) {
          const c = optTheo(env, m, K, 'C');
          const p = optTheo(env, m, K, 'P');
          expect(c - p).toBeCloseTo(env.spot - K + env.rc[m], 9);
        }
      }
    }
  });
});

describe('synthetics', () => {
  it('buy-write fair = P + r/c', () => {
    for (const K of env1.strikes)
      expect(fair(env1, P.bw(env1, 0, K))).toBeCloseTo(optTheo(env1, 0, K, 'P') + env1.rc[0], 9);
  });
  it('puts & stock fair = C - r/c', () => {
    for (const K of env1.strikes)
      expect(fair(env1, P.pns(env1, 0, K))).toBeCloseTo(optTheo(env1, 0, K, 'C') - env1.rc[0], 9);
  });
});

describe('structure identities', () => {
  const K = env1.strikes[2];
  it('fly + iron fly = strike width', () => {
    expect(fair(env1, P.fly(env1, 0, K)) + fair(env1, P.ironFly(env1, 0, K))).toBeCloseTo(5, 9);
  });
  it('call fly = put fly', () => {
    const putFly: P.Product = {
      kind: 'putFly', label: 'put fly',
      legs: [
        { kind: 'opt', m: 0, K: K - 5, right: 'P', q: 1 },
        { kind: 'opt', m: 0, K, right: 'P', q: -2 },
        { kind: 'opt', m: 0, K: K + 5, right: 'P', q: 1 },
      ],
    };
    expect(fair(env1, P.fly(env1, 0, K))).toBeCloseTo(fair(env1, putFly), 9);
  });
  it('box = strike width under constant r/c', () => {
    expect(fair(env1, P.box(env1, 0, K, K + 5))).toBeCloseTo(5, 9);
    expect(fair(env1, P.box(env1, 0, K - 5, K + 5))).toBeCloseTo(10, 9);
  });
  it('roll = carry difference between months', () => {
    for (const K2 of env2.strikes)
      expect(fair(env2, P.roll(env2, K2))).toBeCloseTo(env2.rc[1] - env2.rc[0], 9);
  });
});

describe('no-arbitrage of generated theos', () => {
  it('calls decrease and are convex in strike; puts increase', () => {
    const c = env1.strikes.map((K) => optTheo(env1, 0, K, 'C'));
    const p = env1.strikes.map((K) => optTheo(env1, 0, K, 'P'));
    for (let i = 1; i < c.length; i++) {
      expect(c[i]).toBeLessThan(c[i - 1]);
      expect(p[i]).toBeGreaterThan(p[i - 1]);
    }
    for (let i = 1; i < c.length - 1; i++)
      expect(c[i - 1] - 2 * c[i] + c[i + 1]).toBeGreaterThan(0);
  });
});

describe('risk reversal quoting', () => {
  const prod = P.rr(env1, 0, env1.strikes[2]);
  it('is always displayed positive with a direction', () => {
    expect(fmtPx(prod, 0.15)).toBe('0.15 puts over');
    expect(fmtPx(prod, -0.2)).toBe('0.20 calls over');
  });
});

describe('closure engine', () => {
  const base = newSession({ seed: 1, rounds: 12, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard });
  const K = 100;
  const crafted: GameState = {
    ...structuredClone(base),
    env: { ...base.env, spot: 100, strikes: [90, 95, 100, 105, 110], rc: [0.1] },
    quotes: { [`0|${K}|C`]: { bid: 3.0, ask: 3.2 } },
    orders: [],
  };
  it('routes a missing put synthetically via the call and stock', () => {
    expect(bestBuy(crafted, 0, K, 'P')).toBeCloseTo(3.2 - (99.9 - K) - 0.1, 9); // 3.20
    expect(bestSell(crafted, 0, K, 'P')).toBeCloseTo(3.0 - (100.1 - K) - 0.1, 9); // 2.80
    expect(bestBuy(crafted, 0, K, 'C')).toBeCloseTo(3.2, 9);
    expect(bestSell(crafted, 0, K, 'C')).toBeCloseTo(3.0, 9);
  });
  it('prices a package closure and detects an arb-able order', () => {
    const straddle = P.straddle(crafted.env, 0, K);
    expect(closureBuyCost(crafted, straddle)).toBeCloseTo(3.2 + 3.2, 9);
    expect(closureSellValue(crafted, straddle)).toBeCloseTo(3.0 + 2.8, 9);
    const order: RestingOrder = {
      id: 99, broker: 'T', product: straddle, side: 'bid', price: 6.55, size: 1, ttl: 1, planted: false,
    };
    const withOrder = { ...crafted, orders: [order] };
    expect(orderArbProfit(withOrder, order)).toBeCloseTo(6.55 - 6.4, 9);
  });
  it('detects a direct pair arb between two brokers on the same product', () => {
    const straddle = P.straddle(crafted.env, 0, K);
    // Pair route (6.70 vs 6.30 = 0.40) beats the board closure (6.70 - 6.40 = 0.30).
    const bidO: RestingOrder = { id: 1, broker: 'A', product: straddle, side: 'bid', price: 6.7, size: 1, ttl: 2, planted: false };
    const askO: RestingOrder = { id: 2, broker: 'B', product: straddle, side: 'ask', price: 6.3, size: 1, ttl: 2, planted: false };
    const s2 = { ...crafted, orders: [bidO, askO] };
    expect(orderArbProfit(s2, bidO)).toBeCloseTo(0.4, 9);
  });
  it('flags a missed arb when the order expires', () => {
    const straddle = P.straddle(crafted.env, 0, K);
    const order: RestingOrder = {
      id: 7, broker: 'T', product: straddle, side: 'bid', price: 6.55, size: 1, ttl: 1, planted: false,
    };
    const s2: GameState = { ...structuredClone(crafted), orders: [order], round: 3 };
    const s3 = reduce(s2, { type: 'tick' });
    const d = s3.decisions.find((x) => x.note?.startsWith('missed arb'));
    expect(d).toBeDefined();
    expect(d!.note).toContain('+0.15');
  });
});

describe('the pit', () => {
  const cfg: SessionConfig = { seed: 123, rounds: 20, noise: 1, twoExp: true, shotClock: 0, products: PRODUCT_SETS.hard };
  it('is deterministic for a given seed', () => {
    expect(JSON.stringify(newSession(cfg))).toBe(JSON.stringify(newSession(cfg)));
  });
  it('orders are always anchored and planted orders are closable at a profit', () => {
    for (const seed of [123, 9, 20260711]) {
      let s = newSession({ ...cfg, seed });
      const seen = new Set<number>();
      let planted = 0;
      while (s.phase === 'playing') {
        for (const o of s.orders) {
          for (const l of o.product.legs) {
            if (l.kind !== 'opt') continue;
            const known = s.quotes[`${l.m}|${l.K}|C`] || s.quotes[`${l.m}|${l.K}|P`];
            expect(known, `${o.product.label} leg ${l.K} unanchored`).toBeTruthy();
          }
          if (o.planted && !seen.has(o.id)) {
            planted++;
            const profit = orderArbProfit(s, o);
            expect(profit, `planted ${o.product.label} not arb-able`).not.toBeNull();
            expect(profit!).toBeGreaterThanOrEqual(TICK - 0.001);
          }
          seen.add(o.id);
        }
        s = reduce(s, { type: 'tick' });
      }
      expect(planted).toBeGreaterThan(0);
      expect(pnl(s)).toBeCloseTo(0, 9); // never traded -> flat
    }
  });
  it('filling an order books the position and the theo edge', () => {
    let s = newSession(cfg);
    while (s.phase === 'playing' && !s.orders.length) s = reduce(s, { type: 'tick' });
    const o = s.orders[0];
    const before = pnl(s);
    s = reduce(s, { type: 'order', id: o.id });
    const d = s.decisions[s.decisions.length - 1];
    expect(pnl(s) - before).toBeCloseTo(d.edge, 9);
    expect(isFlat(s)).toBe(false);
  });
  it('make-a-market targets an empty cell whose counterpart strike is quoted', () => {
    let seen = 0;
    for (const seed of [123, 5, 999, 3344810]) {
      let s = newSession({ seed, rounds: 24, noise: 1, twoExp: seed % 2 === 1, shotClock: 0, products: PRODUCT_SETS.hard });
      while (s.phase === 'playing') {
        if (s.mm) {
          seen++;
          expect(s.mm.product.legs).toHaveLength(1);
          const l = s.mm.product.legs[0] as { m: number; K: number; right: 'C' | 'P' };
          expect(s.quotes[`${l.m}|${l.K}|${l.right}`]).toBeUndefined();
          expect(s.quotes[`${l.m}|${l.K}|${l.right === 'C' ? 'P' : 'C'}`]).toBeDefined();
          s = reduce(s, { type: 'pass' });
        } else s = reduce(s, { type: 'tick' });
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
  it('a market that holds is posted; a bid through fair is picked off and corrected', () => {
    let s = newSession(cfg);
    while (s.phase === 'playing' && !s.mm) s = reduce(s, { type: 'tick' });
    expect(s.phase).toBe('playing');
    const l = s.mm!.product.legs[0] as { m: number; K: number; right: 'C' | 'P' };
    const f = s.mm!.fair;
    const bid = roundTick(f - 2 * TICK);
    const ask = roundTick(f + 2 * TICK);
    const held = reduce(s, { type: 'mm', bid, ask });
    expect(held.quotes[`${l.m}|${l.K}|${l.right}`]).toEqual({ bid, ask });

    const badBid = roundTick(f + 3 * TICK);
    const picked = reduce(s, { type: 'mm', bid: badBid, ask: roundTick(badBid + 2 * TICK) });
    const d = picked.decisions[picked.decisions.length - 1];
    expect(d.edge).toBeLessThan(0);
    expect(d.note).toContain('picked off');
    expect(picked.quotes[`${l.m}|${l.K}|${l.right}`]).toBeDefined();
  });
  it('board trades fill at the posted quote and record spread cost', () => {
    let s = newSession(cfg);
    const key = Object.keys(s.quotes)[0];
    const [m, K, right] = key.split('|');
    const before = pnl(s);
    s = reduce(s, { type: 'board', m: Number(m), K: Number(K), right: right as 'C' | 'P', side: 'ask' });
    const d = s.decisions[s.decisions.length - 1];
    expect(pnl(s) - before).toBeCloseTo(d.edge, 9);
  });
});

describe('P&L: the canonical example', () => {
  it('nets +0.05 after the stock hedge', () => {
    const cfg: SessionConfig = { seed: 7, rounds: 24, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard };
    const s: GameState = newSession(cfg);
    const K = s.env.strikes[1];
    const callProd = P.call(s.env, 0, K);
    const f = fair(s.env, callProd);
    applyFill(s, callProd, -1, f + 0.15);
    expect(pnl(s)).toBeCloseTo(0.15, 9);
    applyFill(s, { kind: 'stk', label: 'stock', legs: [{ kind: 'stock', q: 1 }] }, 1, s.env.spot + 0.1);
    expect(pnl(s)).toBeCloseTo(0.05, 9);
  });
  it('recognizes riskless books: conversions and boxes lock, naked legs do not', () => {
    const cfg: SessionConfig = { seed: 11, rounds: 24, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard };
    const s = newSession(cfg);
    const K = s.env.strikes[2];
    // conversion: buy the BW-quoted package (long call, short stock), sell the put
    applyFill(s, P.bw(s.env, 0, K), 1, 1.0);
    expect(isRiskless(s)).toBe(false);
    applyFill(s, P.put(s.env, 0, K), -1, 1.0);
    expect(isRiskless(s)).toBe(true);
    // pnl of a riskless book is invariant to the stock
    const before = pnl(s);
    const moved = { ...s, env: { ...s.env, spot: s.env.spot + 3 } };
    expect(pnl(moved)).toBeCloseTo(before, 6);
    // a box is riskless too
    const s2 = newSession(cfg);
    applyFill(s2, P.box(s2.env, 0, s2.env.strikes[1], s2.env.strikes[2]), 1, 4.95);
    expect(isRiskless(s2)).toBe(true);
    // a lone call plus stock hedge is not
    const s3 = newSession(cfg);
    applyFill(s3, P.call(s3.env, 0, K), -1, 2.0);
    s3.posStock += 1;
    expect(isRiskless(s3)).toBe(false);
  });
  it('a riskless carry book trades out at fair, preserving pnl exactly', () => {
    const cfg: SessionConfig = { seed: 13, rounds: 24, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard };
    const s = newSession(cfg);
    const K = s.env.strikes[2];
    // combo (long call, short put) ten times, hedged with short stock -> long the r/c
    applyFill(s, P.call(s.env, 0, K), 10, 3.0);
    applyFill(s, P.put(s.env, 0, K), -10, 2.0);
    s.posStock -= 10;
    s.cash += 10 * (s.env.spot - 0.1);
    expect(isFlat(s)).toBe(false);
    expect(isRiskless(s)).toBe(true);
    const before = pnl(s);
    const s2 = reduce(s, { type: 'unwind' });
    expect(isFlat(s2)).toBe(true);
    expect(pnl(s2)).toBeCloseTo(before, 9);
    expect(s2.cash + s2.banked).toBeCloseTo(before, 9);
  });
  it('trade-out is refused while the book has risk on', () => {
    const cfg: SessionConfig = { seed: 13, rounds: 24, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard };
    const s = newSession(cfg);
    applyFill(s, P.call(s.env, 0, s.env.strikes[2]), 10, 3.0);
    expect(isRiskless(s)).toBe(false);
    const s2 = reduce(s, { type: 'unwind' });
    expect(Object.keys(s2.posOpt).length).toBeGreaterThan(0);
  });
  it('a flat book has pnl = cash + banked (locked)', () => {
    const cfg: SessionConfig = { seed: 9, rounds: 24, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard };
    const s = newSession(cfg);
    const K = s.env.strikes[3];
    const bwProd = P.bw(s.env, 0, K);
    const f = fair(s.env, bwProd);
    applyFill(s, bwProd, 1, f - 0.2);
    applyFill(s, bwProd, -1, f);
    expect(isFlat(s)).toBe(true);
    expect(pnl(s)).toBeCloseTo(s.cash + s.banked, 9);
    expect(pnl(s)).toBeCloseTo(0.2, 9);
  });
});

describe('quote generation', () => {
  it('crowd quotes are tick-aligned, non-negative, bid < ask', () => {
    const s = newSession({ seed: 55, rounds: 24, noise: 2, twoExp: true, shotClock: 0, products: PRODUCT_SETS.hard });
    for (const q of Object.values(s.quotes)) {
      expect(q.bid).toBeGreaterThanOrEqual(0);
      expect(q.ask).toBeGreaterThan(q.bid);
      expect(Math.abs(q.bid * 20 - Math.round(q.bid * 20))).toBeLessThan(1e-9);
      expect(Math.abs(q.ask * 20 - Math.round(q.ask * 20))).toBeLessThan(1e-9);
    }
  });
  it('crowd quotes respect parity within a strike (skew shared by call and put)', () => {
    let s = newSession({ seed: 314, rounds: 24, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard });
    while (s.phase === 'playing') s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
    for (const K of s.env.strikes) {
      const c = s.quotes[`0|${K}|C`];
      const p = s.quotes[`0|${K}|P`];
      if (!c || !p) continue;
      const cMid = (c.bid + c.ask) / 2;
      const pMid = (p.bid + p.ask) / 2;
      expect(Math.abs(cMid - pMid - (s.env.spot - K + s.env.rc[0]))).toBeLessThanOrEqual(0.051);
    }
  });
});

describe('difficulty product sets', () => {
  it('easy sessions only quote singles, puts & stock, and buy-writes', () => {
    for (const seed of [3, 44, 500]) {
      let s = newSession({ seed, rounds: 20, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.easy });
      while (s.phase === 'playing') {
        for (const o of s.orders) expect(PRODUCT_SETS.easy).toContain(o.product.kind);
        s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
      }
    }
  });
  it('a custom single-product session quotes only that product', () => {
    let s = newSession({ seed: 8, rounds: 20, noise: 1, twoExp: false, shotClock: 0, products: ['straddle'] });
    let seenOrders = 0;
    while (s.phase === 'playing') {
      for (const o of s.orders) {
        seenOrders++;
        expect(o.product.kind).toBe('straddle');
      }
      s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
    }
    expect(seenOrders).toBeGreaterThan(0);
  });
  it('rolls stay out of single-expiry sessions even when enabled', () => {
    let s = newSession({ seed: 21, rounds: 20, noise: 1, twoExp: false, shotClock: 0, products: ['roll', 'straddle'] });
    while (s.phase === 'playing') {
      for (const o of s.orders) expect(o.product.kind).not.toBe('roll');
      s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
    }
  });
});

describe('parity drill', () => {
  it('generates clean, consistent questions', () => {
    const qs = makeDrill(77, 15);
    expect(qs).toHaveLength(15);
    for (const q of qs) {
      expect(q.answer).toBeGreaterThan(0);
      expect(Math.abs(q.answer * 100 - Math.round(q.answer * 100))).toBeLessThan(1e-6);
    }
  });
  it('put -> call answers satisfy parity', () => {
    const qs = makeDrill(123, 40).filter((q) => q.prompt.includes('Fair for the') && q.prompt.includes('call?'));
    for (const q of qs) {
      const S = Number(/Stock (\d+\.\d+)/.exec(q.prompt)![1]);
      const rc = Number(/r\/c (\d+\.\d+)/.exec(q.prompt)![1]);
      const K = Number(/The (\d+) put/.exec(q.prompt)![1]);
      const put = Number(/put is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(put + (S - K) + rc, 9);
    }
  });
});

describe('forward convention', () => {
  it('forward = spot + r/c so parity is the class convention', () => {
    expect(fwd(env2, 0)).toBeCloseTo(env2.spot + 0.1, 9);
    expect(fwd(env2, 1)).toBeCloseTo(env2.spot + 0.25, 9);
  });
});
