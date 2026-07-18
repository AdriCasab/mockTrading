import { useEffect, useRef } from 'react';
import { GameState, pnl, usd } from '../engine/session';
import { HistEntry, loadHistory } from './Setup';

export default function Debrief({ s, onAgain }: { s: GameState; onAgain: () => void }) {
  const score = pnl(s);
  const saved = useRef(false);
  const avgCapture = s.captureTicks.length
    ? s.captureTicks.reduce((a, b) => a + b, 0) / s.captureTicks.length
    : null;

  useEffect(() => {
    if (saved.current) return;
    saved.current = true;
    const entry: HistEntry = {
      date: new Date().toISOString().slice(0, 10),
      seed: s.cfg.seed,
      rounds: s.cfg.rounds,
      score: Math.round(score * 100) / 100,
      ...(avgCapture !== null ? { capture: Math.round(avgCapture * 10) / 10 } : {}),
    };
    localStorage.setItem('mt-history', JSON.stringify([entry, ...loadHistory()].slice(0, 20)));
  }, [s, score, avgCapture]);

  const trades = s.decisions.filter((d) => d.edge !== 0 || d.action.includes('at'));
  const pickoffs = s.decisions.filter((d) => d.note?.includes('picked off')).length;
  const missed = s.decisions.filter((d) => d.note?.startsWith('missed arb')).length;
  const edgeSum = s.decisions.reduce((a, d) => a + d.edge, 0);
  const drift = score - edgeSum;
  const bell = s.decisions.find((d) => d.label === 'closing bell');

  return (
    <div className="app setup">
      <h1>Debrief</h1>
      <div className="card scoreCard">
        <p className="dim">Net edge after hedging</p>
        <p className={`score ${score >= 0 ? 'pos' : 'neg'}`}>{usd(score)}</p>
        <p className="dim small">
          {s.arbsSeen} arb{s.arbsSeen === 1 ? '' : 's'} surfaced · {s.arbsCaptured} captured ·{' '}
          {missed} missed · {pickoffs} pick-off{pickoffs === 1 ? '' : 's'}
          {avgCapture !== null &&
            ` · struck in ${avgCapture.toFixed(1)} tick${avgCapture === 1 ? '' : 's'} on average`}
        </p>
        <p className="dim small">
          {trades.length} trade{trades.length === 1 ? '' : 's'} ·{' '}
          {!bell
            ? 'you went into the bell flat — everything realized'
            : bell.action.includes('carry')
              ? 'carry book redeemed at the bell'
              : `you carried risk into the bell (${usd(bell.edge)} to get flat)`}
          {Math.abs(drift) > 0.005 && ` · ${usd(drift)} from market moves on open positions`}
        </p>
      </div>
      <div className="card">
        <h2>Every decision</h2>
        <div className="tableWrap">
          <table className="debrief">
            <thead>
              <tr>
                <th>#</th>
                <th>product</th>
                <th>you</th>
                <th>fair</th>
                <th>edge</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.decisions.map((d, i) => (
                <tr key={i}>
                  <td className="dim">{d.round}</td>
                  <td>{d.label}</td>
                  <td>{d.action}</td>
                  <td>{d.fair.toFixed(2)}</td>
                  <td className={d.edge > 0.005 ? 'pos' : d.edge < -0.005 ? 'neg' : 'dim'}>
                    {usd(d.edge)}
                  </td>
                  <td className="dim">{d.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <button className="primary big" onClick={onAgain}>
        New session
      </button>
    </div>
  );
}
