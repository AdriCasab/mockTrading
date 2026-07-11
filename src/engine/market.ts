import { Rng } from './rng';
import { black76Call, black76CallDelta } from './black';

export const TICK = 0.05;
export const roundTick = (p: number) => Math.round(p * 20) / 20;
export const fmt = (p: number) => p.toFixed(2);

export type Right = 'C' | 'P';

export type Env = {
  spot: number;
  strikes: number[];
  months: string[];
  rc: number[]; // cost of carry per month, constant across strikes
  T: number[];
  baseVol: number;
  skew: number;
  curv: number;
};

export function makeEnv(r: Rng, twoExp: boolean): Env {
  const center = 5 * (18 + Math.floor(r.next() * 9)); // 90..130
  const spot = roundTick(center + (r.next() * 4.8 - 2.4));
  return {
    spot,
    strikes: [-2, -1, 0, 1, 2].map((i) => center + 5 * i),
    months: twoExp ? ['Jul', 'Aug'] : ['Jul'],
    rc: twoExp ? [0.1, 0.25] : [0.1],
    T: twoExp ? [30 / 365, 58 / 365] : [30 / 365],
    baseVol: 0.22 + r.next() * 0.18,
    skew: -0.1,
    curv: 0.6,
  };
}

export const fwd = (env: Env, m: number) => env.spot + env.rc[m];

export function vol(env: Env, m: number, K: number): number {
  const x = Math.log(K / fwd(env, m));
  return Math.max(0.08, env.baseVol + env.skew * x + env.curv * x * x);
}

export function optTheo(env: Env, m: number, K: number, right: Right): number {
  const c = black76Call(fwd(env, m), K, vol(env, m, K), env.T[m]);
  return right === 'C' ? c : c - (fwd(env, m) - K);
}

export function optDelta(env: Env, m: number, K: number, right: Right): number {
  const d = black76CallDelta(fwd(env, m), K, vol(env, m, K), env.T[m]);
  return right === 'C' ? d : d - 1;
}

export const STOCK_HALF_SPREAD = 0.1;
export const stockBid = (env: Env) => roundTick(env.spot - STOCK_HALF_SPREAD);
export const stockAsk = (env: Env) => roundTick(env.spot + STOCK_HALF_SPREAD);
