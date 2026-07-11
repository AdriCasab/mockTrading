import { useState } from 'react';
import { Noise, SessionConfig } from '../engine/session';

export type HistEntry = { date: string; seed: number; rounds: number; score: number };

export function loadHistory(): HistEntry[] {
  try {
    return JSON.parse(localStorage.getItem('mt-history') ?? '[]');
  } catch {
    return [];
  }
}

const randSeed = () => Math.floor(Math.random() * 900000) + 100000;

export default function Setup({
  onStart,
  onDrill,
}: {
  onStart: (cfg: SessionConfig) => void;
  onDrill: () => void;
}) {
  const [seed, setSeed] = useState(randSeed());
  const [rounds, setRounds] = useState(24);
  const [noise, setNoise] = useState<Noise>(1);
  const [twoExp, setTwoExp] = useState(false);
  const [timed, setTimed] = useState(true);
  const [secs, setSecs] = useState(25);
  const hist = loadHistory();

  return (
    <div className="app setup">
      <h1>Mock trading</h1>
      <p className="dim">
        A sparse five-strike board and a pit full of brokers barking simultaneous orders. Find
        the order you can arb out for free — trade it, close the legs, lock the profit, stay
        flat. Score is net edge after hedging.
      </p>
      <div className="card">
        <label className="row">
          <span>Scenario seed</span>
          <span className="grow" />
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value) || 1)}
            inputMode="numeric"
          />
          <button type="button" onClick={() => setSeed(randSeed())}>New</button>
        </label>
        <label className="row">
          <span>Rounds</span>
          <span className="grow" />
          <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
            <option value={12}>12 — quick</option>
            <option value={24}>24 — full session</option>
            <option value={36}>36 — long</option>
          </select>
        </label>
        <label className="row">
          <span>Instructor noise</span>
          <span className="grow" />
          <select value={noise} onChange={(e) => setNoise(Number(e.target.value) as Noise)}>
            <option value={0}>Low — small mispricings</option>
            <option value={1}>Medium</option>
            <option value={2}>High — wild quotes</option>
          </select>
        </label>
        <label className="row">
          <span>Two expirations (enables roll spreads)</span>
          <span className="grow" />
          <input type="checkbox" checked={twoExp} onChange={(e) => setTwoExp(e.target.checked)} />
        </label>
        <label className="row">
          <span>Pit clock (seconds per tick)</span>
          <span className="grow" />
          <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} />
          {timed && (
            <select value={secs} onChange={(e) => setSecs(Number(e.target.value))}>
              <option value={15}>15s</option>
              <option value={25}>25s</option>
              <option value={40}>40s</option>
            </select>
          )}
        </label>
        <button
          className="primary big"
          onClick={() => onStart({ seed, rounds, noise, twoExp, shotClock: timed ? secs : 0 })}
        >
          Open the pit
        </button>
        <button className="big" onClick={onDrill}>
          Parity drill — 15 questions against the clock
        </button>
      </div>
      {hist.length > 0 && (
        <div className="card">
          <h2>Past sessions</h2>
          {hist.slice(0, 8).map((h, i) => (
            <div className="row histRow" key={i}>
              <span className="dim">{h.date}</span>
              <span className="dim">seed {h.seed}</span>
              <span className="grow" />
              <span className={h.score >= 0 ? 'pos' : 'neg'}>
                {h.score >= 0 ? '+' : ''}
                {h.score.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
