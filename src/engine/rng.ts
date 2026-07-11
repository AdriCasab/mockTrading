export type Rng = { state: number; next(): number };

export function mulberry32(seed: number): Rng {
  return {
    state: seed >>> 0,
    next() {
      this.state = (this.state + 0x6d2b79f5) >>> 0;
      let t = this.state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function pick<T>(r: Rng, xs: readonly T[]): T {
  return xs[Math.floor(r.next() * xs.length)];
}

export function normal(r: Rng): number {
  const u = Math.max(r.next(), 1e-12);
  const v = r.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
