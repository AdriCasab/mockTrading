import { describe, it, expect } from 'vitest';
import { mulberry32 } from './rng';
import { makeEnv, optTheo, fwd, TICK, roundTick } from './market';
import * as P from './products';
import { fair, fmtPx } from './products';
import {
  newSession, reduce, applyFill, pnl, isFlat, isRiskless, GameState, SessionConfig, RestingOrder, PRODUCT_SETS,
  bestBuy, bestSell, closureBuyCost, closureSellValue, orderArbProfit, usd,
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
  it('combo = C - P, the parity quantity: fair is (S - K) + r/c at every strike', () => {
    for (const env of [env1, env2]) {
      for (let m = 0; m < env.months.length; m++) {
        for (const K2 of env.strikes) {
          const f = fair(env, P.combo(env, m, K2));
          expect(f).toBeCloseTo(env.spot - K2 + env.rc[m], 9);
          // combo + strike = the same synthetic stock at every line
          expect(f + K2).toBeCloseTo(env.spot + env.rc[m], 9);
        }
      }
    }
  });
  it('combo quotes are net premium, puts-over when negative', () => {
    const c = P.combo(env1, 0, env1.strikes[2]);
    expect(fmtPx(c, 0.15)).toBe('0.15');
    expect(fmtPx(c, -4.7)).toBe('4.70 puts over');
  });
  it('a combo hedged with stock is riskless and trades out at fair', () => {
    const cfg: SessionConfig = { seed: 31, rounds: 24, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.easy };
    const s = newSession(cfg);
    const K2 = s.env.strikes[1];
    const comboProd = P.combo(s.env, 0, K2);
    applyFill(s, comboProd, 10, fair(s.env, comboProd) + 0.02); // paid 0.02 over fair
    s.posStock -= 10;
    s.cash += 10 * (s.env.spot - 0.1);
    expect(isRiskless(s)).toBe(true);
    const before = pnl(s);
    const s2 = reduce(s, { type: 'unwind' });
    expect(isFlat(s2)).toBe(true);
    expect(pnl(s2)).toBeCloseTo(before, 9);
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
      id: 99, broker: 'T', product: straddle, side: 'bid', price: 6.55, size: 1, ttl: 1, planted: false, born: 0,
    };
    const withOrder = { ...crafted, orders: [order] };
    expect(orderArbProfit(withOrder, order)).toBeCloseTo(6.55 - 6.4, 9);
  });
  it('detects a direct pair arb between two brokers on the same product', () => {
    const straddle = P.straddle(crafted.env, 0, K);
    // Pair route (6.70 vs 6.30 = 0.40) beats the board closure (6.70 - 6.40 = 0.30).
    const bidO: RestingOrder = { id: 1, broker: 'A', product: straddle, side: 'bid', price: 6.7, size: 1, ttl: 2, planted: false, born: 0 };
    const askO: RestingOrder = { id: 2, broker: 'B', product: straddle, side: 'ask', price: 6.3, size: 1, ttl: 2, planted: false, born: 0 };
    const s2 = { ...crafted, orders: [bidO, askO] };
    expect(orderArbProfit(s2, bidO)).toBeCloseTo(0.4, 9);
  });
  it('flags a missed arb when the order expires', () => {
    const straddle = P.straddle(crafted.env, 0, K);
    const order: RestingOrder = {
      id: 7, broker: 'T', product: straddle, side: 'bid', price: 6.55, size: 1, ttl: 1, planted: false, born: 0,
    };
    const s2: GameState = { ...structuredClone(crafted), orders: [order], round: 3 };
    const s3 = reduce(s2, { type: 'tick' });
    const d = s3.decisions.find((x) => x.note?.startsWith('missed arb'));
    expect(d).toBeDefined();
    expect(d!.note).toContain('+$15'); // 0.15/lot on 1 lot of a 100-share contract
  });
});

describe('dollar display', () => {
  it('converts price units to contract dollars', () => {
    expect(usd(0.5)).toBe('+$50');
    expect(usd(-0.173)).toBe('-$17.30');
    expect(usd(0.4823)).toBe('+$48.23');
    expect(usd(0)).toBe('+$0');
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

describe('speed stats and variety', () => {
  it('capturing an arb records how many ticks it had been resting', () => {
    let s = newSession({ seed: 123, rounds: 20, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard });
    while (s.phase === 'playing' && !s.orders.some((o) => o.planted)) {
      s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
    }
    expect(s.phase).toBe('playing');
    const o = s.orders.find((x) => x.planted)!;
    const expected = s.round - o.born;
    s = reduce(s, { type: 'order', id: o.id });
    expect(s.captureTicks).toHaveLength(1);
    expect(s.captureTicks[0]).toBe(Math.max(0, expected));
    expect(s.arbsCaptured).toBe(1);
  });
  it('the pit avoids re-quoting a product that is already resting', () => {
    for (const seed of [123, 7, 909]) {
      let s = newSession({ seed, rounds: 24, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.hard });
      while (s.phase === 'playing') {
        const labels = s.orders.map((o) => o.product.label);
        expect(new Set(labels).size, `duplicate resting orders: ${labels.join(', ')}`).toBe(labels.length);
        s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
      }
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

describe('the closing bell', () => {
  const cfg: SessionConfig = { seed: 77, rounds: 12, noise: 1, twoExp: false, shotClock: 0, products: PRODUCT_SETS.easy };
  it('force-flattens open risk at market prices', () => {
    let s = newSession(cfg);
    for (let i = 0; i < 6 && s.phase === 'playing'; i++) s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
    applyFill(s, P.call(s.env, 0, s.env.strikes[2]), 10, 3.0);
    while (s.phase === 'playing') s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
    expect(isFlat(s)).toBe(true);
    const bell = s.decisions.find((d) => d.label === 'closing bell')!;
    expect(bell.action).toBe('forced flat at market');
    expect(bell.edge).toBeLessThanOrEqual(0.000001); // liquidation never beats the mark
    expect(pnl(s)).toBeCloseTo(s.cash + s.banked, 9); // fully realized
  });
  it('redeems a riskless carry book at fair, costlessly', () => {
    let s = newSession(cfg);
    const K = s.env.strikes[2];
    applyFill(s, P.combo(s.env, 0, K), 10, 1.0);
    s.posStock -= 10;
    s.cash += 10 * s.env.spot;
    expect(isRiskless(s)).toBe(true);
    const before = pnl(s);
    while (s.phase === 'playing') s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
    expect(isFlat(s)).toBe(true);
    const bell = s.decisions.find((d) => d.label === 'closing bell')!;
    expect(bell.action).toBe('carry redeemed at fair');
    expect(pnl(s)).toBeCloseTo(before, 9);
  });
  it('a flat book hears no bell', () => {
    let s = newSession(cfg);
    while (s.phase === 'playing') s = reduce(s, s.mm ? { type: 'pass' } : { type: 'tick' });
    expect(s.decisions.find((d) => d.label === 'closing bell')).toBeUndefined();
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
  it('easy drills stay in the parity family', () => {
    const qs = makeDrill(5, 40, 'easy');
    for (const q of qs)
      expect(/call\?|put\?|buy-write\?|puts & stock\?|combo\?/.test(q.prompt), q.prompt).toBe(true);
  });
  it('hard drills include structure identities with exact answers', () => {
    const qs = makeDrill(99, 80, 'hard');
    const boxes = qs.filter((q) => q.prompt.includes('box?'));
    expect(boxes.length).toBeGreaterThan(0);
    for (const q of boxes) {
      const m = /the (\d+)\/(\d+) box/.exec(q.prompt)!;
      expect(q.answer).toBe(Number(m[2]) - Number(m[1]));
    }
    const putSpreads = qs.filter((q) => q.prompt.includes('put spread?'));
    expect(putSpreads.length).toBeGreaterThan(0);
    for (const q of putSpreads) {
      const cs = Number(/call spread is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(5 - cs, 9);
    }
    const flyIrons = qs.filter((q) => /\d+\/\d+\/\d+ fly is/.test(q.prompt));
    expect(flyIrons.length).toBeGreaterThan(0);
    for (const q of flyIrons) {
      const fly = Number(/fly is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(5 - fly, 9);
    }
    const combos = qs.filter((q) => q.prompt.includes('combo?'));
    for (const q of combos) {
      const S = Number(/Stock (\d+\.\d+)/.exec(q.prompt)![1]);
      const rc = Number(/r\/c (\d+\.\d+)/.exec(q.prompt)![1]);
      const K = Number(/the (\d+) combo/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(S - K + rc, 9);
    }
  });
  it('put -> call answers satisfy parity', () => {
    const qs = makeDrill(123, 60).filter((q) => q.prompt.includes('call?') && / put is /.test(q.prompt));
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      const S = Number(/Stock (\d+\.\d+)/.exec(q.prompt)![1]);
      const rc = Number(/r\/c (\d+\.\d+)/.exec(q.prompt)![1]);
      const K = Number(/The (\d+) put/.exec(q.prompt)![1]);
      const put = Number(/put is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(put + (S - K) + rc, 9);
    }
  });
  it('reverse conversions recover the option from the package', () => {
    const qs = makeDrill(321, 120, 'easy');
    const pnsToPut = qs.filter((q) => q.prompt.includes('puts & stock is') && q.prompt.includes('put?'));
    expect(pnsToPut.length).toBeGreaterThan(0);
    for (const q of pnsToPut) {
      const S = Number(/Stock (\d+\.\d+)/.exec(q.prompt)![1]);
      const K = Number(/The (\d+) puts & stock/.exec(q.prompt)![1]);
      const pns = Number(/puts & stock is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(pns - (S - K), 9); // r/c is a distractor here
    }
    const bwToCall = qs.filter((q) => q.prompt.includes('buy-write is') && q.prompt.includes('call?'));
    expect(bwToCall.length).toBeGreaterThan(0);
    for (const q of bwToCall) {
      const S = Number(/Stock (\d+\.\d+)/.exec(q.prompt)![1]);
      const K = Number(/The (\d+) buy-write/.exec(q.prompt)![1]);
      const bw = Number(/buy-write is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(bw + (S - K), 9);
    }
    const bwToPut = qs.filter((q) => q.prompt.includes('buy-write is') && q.prompt.includes('put?'));
    expect(bwToPut.length).toBeGreaterThan(0);
    for (const q of bwToPut) {
      const rc = Number(/r\/c (\d+\.\d+)/.exec(q.prompt)![1]);
      const bw = Number(/buy-write is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(bw - rc, 9); // stock is a distractor here
    }
    const pnsToCall = qs.filter((q) => q.prompt.includes('puts & stock is') && q.prompt.includes('call?'));
    expect(pnsToCall.length).toBeGreaterThan(0);
    for (const q of pnsToCall) {
      const rc = Number(/r\/c (\d+\.\d+)/.exec(q.prompt)![1]);
      const pns = Number(/puts & stock is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(pns + rc, 9);
    }
  });
  it('BW + P&S = straddle in the medium drill', () => {
    const qs = makeDrill(55, 120, 'medium').filter((q) => q.prompt.includes('straddle?') && q.prompt.includes('buy-write'));
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      const bw = Number(/buy-write is (\d+\.\d+)/.exec(q.prompt)![1]);
      const pns = Number(/puts & stock is (\d+\.\d+)/.exec(q.prompt)![1]);
      expect(q.answer).toBeCloseTo(bw + pns, 9);
    }
  });
});

describe('market drill', () => {
  const parseMkt = (re: RegExp, p: string) => {
    const m = re.exec(p)!;
    return { bid: Number(m[1]), ask: Number(m[2]) };
  };
  const num = (re: RegExp, p: string) => Number(re.exec(p)![1]);
  it('answers are positive, exact to the cent, and always ask a side', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const qs = makeDrill(11, 60, level, 'market');
      expect(qs).toHaveLength(60);
      for (const q of qs) {
        expect(q.answer).toBeGreaterThan(0);
        expect(Math.abs(q.answer * 100 - Math.round(q.answer * 100))).toBeLessThan(1e-6);
        expect(/Where can you (buy|sell)/.test(q.prompt), q.prompt).toBe(true);
      }
    }
  });
  it('buying the call from the put market crosses same-side stock', () => {
    const qs = makeDrill(21, 200, 'easy', 'market').filter(
      (q) => q.prompt.includes('puts are') && q.prompt.includes('call?')
    );
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      const stk = parseMkt(/Stock (\d+\.\d+) @ (\d+\.\d+)/, q.prompt);
      const put = parseMkt(/puts are (\d+\.\d+) @ (\d+\.\d+)/, q.prompt);
      const rc = num(/r\/c (\d+\.\d+)/, q.prompt);
      const K = num(/The (\d+) puts are/, q.prompt);
      if (q.prompt.includes('you buy')) expect(q.answer).toBeCloseTo(put.ask + (stk.ask - K) + rc, 9);
      else expect(q.answer).toBeCloseTo(put.bid + (stk.bid - K) + rc, 9);
    }
  });
  it('buying the put from puts & stock flips the stock side', () => {
    const qs = makeDrill(22, 300, 'easy', 'market').filter(
      (q) => q.prompt.includes('puts & stock is') && q.prompt.includes('put?')
    );
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      const stk = parseMkt(/Stock (\d+\.\d+) @ (\d+\.\d+)/, q.prompt);
      const pns = parseMkt(/puts & stock is (\d+\.\d+) @ (\d+\.\d+)/, q.prompt);
      const K = num(/The (\d+) puts & stock/, q.prompt);
      if (q.prompt.includes('you buy')) expect(q.answer).toBeCloseTo(pns.ask - (stk.bid - K), 9);
      else expect(q.answer).toBeCloseTo(pns.bid - (stk.ask - K), 9);
    }
  });
  it('the put spread side comes from the opposite call spread side', () => {
    const qs = makeDrill(23, 300, 'medium', 'market').filter(
      (q) => q.prompt.includes('call spread is') && q.prompt.includes('put spread?')
    );
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      const cs = parseMkt(/call spread is (\d+\.\d+) @ (\d+\.\d+)/, q.prompt);
      if (q.prompt.includes('you buy')) expect(q.answer).toBeCloseTo(5 - cs.bid, 9);
      else expect(q.answer).toBeCloseTo(5 - cs.ask, 9);
    }
  });
  it('the iron fly crosses the straddle and strangle on opposite sides', () => {
    const qs = makeDrill(24, 300, 'hard', 'market').filter(
      (q) => q.prompt.includes('strangle is') && q.prompt.includes('iron fly?')
    );
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      const strad = parseMkt(/straddle is (\d+\.\d+) @ (\d+\.\d+)/, q.prompt);
      const strangle = parseMkt(/strangle is (\d+\.\d+) @ (\d+\.\d+)/, q.prompt);
      if (q.prompt.includes('you buy')) expect(q.answer).toBeCloseTo(strad.ask - strangle.bid, 9);
      else expect(q.answer).toBeCloseTo(strad.bid - strangle.ask, 9);
    }
  });
});

describe('forward convention', () => {
  it('forward = spot + r/c so parity is the class convention', () => {
    expect(fwd(env2, 0)).toBeCloseTo(env2.spot + 0.1, 9);
    expect(fwd(env2, 1)).toBeCloseTo(env2.spot + 0.25, 9);
  });
});
