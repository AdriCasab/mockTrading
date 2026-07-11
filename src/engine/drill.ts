import { mulberry32, pick } from './rng';
import { roundTick } from './market';

// The timed put/call parity drill SIG trainees ran between pit sessions:
// one parity conversion per question, answers land exactly on the cent.
export type DrillQuestion = { prompt: string; answer: number };

export function makeDrill(seed: number, n = 15): DrillQuestion[] {
  const r = mulberry32(seed || 1);
  const qs: DrillQuestion[] = [];
  let guard = 0;
  while (qs.length < n && guard++ < n * 20) {
    const K = 5 * (12 + Math.floor(r.next() * 21)); // 60..160
    const S = roundTick(K + (r.next() * 16 - 8)); // within ±8 of strike
    const rc = pick(r, [0.05, 0.1, 0.15, 0.2]);
    const parity = Math.round((S - K + rc) * 100) / 100; // C - P
    const putPx = roundTick(0.3 + r.next() * 4);
    const callPx = Math.round((putPx + parity) * 100) / 100;
    if (callPx < 0.05) continue;
    const base = `Stock ${S.toFixed(2)}, r/c ${rc.toFixed(2)}.`;
    switch (Math.floor(r.next() * 4)) {
      case 0:
        qs.push({ prompt: `${base} The ${K} put is ${putPx.toFixed(2)}. Fair for the ${K} call?`, answer: callPx });
        break;
      case 1:
        qs.push({ prompt: `${base} The ${K} call is ${callPx.toFixed(2)}. Fair for the ${K} put?`, answer: putPx });
        break;
      case 2:
        qs.push({
          prompt: `${base} The ${K} put is ${putPx.toFixed(2)}. Fair for the ${K} buy-write?`,
          answer: Math.round((putPx + rc) * 100) / 100,
        });
        break;
      default:
        qs.push({
          prompt: `${base} The ${K} call is ${callPx.toFixed(2)}. Fair for the ${K} puts & stock?`,
          answer: Math.round((callPx - rc) * 100) / 100,
        });
    }
  }
  return qs;
}
