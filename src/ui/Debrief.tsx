import { useEffect, useRef } from 'react';
import { GameState, isFlat, isRiskless, pnl } from '../engine/session';
import { HistEntry, loadHistory } from './Setup';

export default function Debrief({ s, onAgain }: { s: GameState; onAgain: () => void }) {
  const score = pnl(s);
  const saved = useRef(false);

  useEffect(() => {
    if (saved.current) return;
    saved.current = true;
    const entry: HistEntry = {
      date: new Date().toISOString().slice(0, 10),
      seed: s.cfg.seed,
      rounds: s.cfg.rounds,
      score: Math.round(score * 100) / 100,
    };
    localStorage.setItem('mt-history', JSON.stringify([entry, ...loadHistory()].slice(0, 20)));
  }, [s, score]);

  const trades = s.decisions.filter((d) => d.edge !== 0 || d.action.includes('at'));
  const pickoffs = s.decisions.filter((d) => d.note?.includes('picked off')).length;
  const missed = s.decisions.filter((d) => d.note?.startsWith('missed arb')).length;
  const edgeSum = s.decisions.reduce((a, d) => a + d.edge, 0);
  const drift = score - edgeSum;
  const flat = isFlat(s) || isRiskless(s);

  return (
    <div className="app setup">
      <h1>Debrief</h1>
      <div className="card scoreCard">
        <p className="dim">Net edge after hedging</p>
        <p className={`score ${score >= 0 ? 'pos' : 'neg'}`}>
          {score >= 0 ? '+' : ''}
          {score.toFixed(2)}
        </p>
        <p className="dim small">
          {s.arbsSeen} arb{s.arbsSeen === 1 ? '' : 's'} surfaced · {s.arbsCaptured} captured ·{' '}
          {missed} missed · {pickoffs} pick-off{pickoffs === 1 ? '' : 's'}
        </p>
        <p className="dim small">
          {trades.length} trade{trades.length === 1 ? '' : 's'} ·{' '}
          {flat ? 'you finished flat — everything locked' : 'you finished with open risk'}
          {Math.abs(drift) > 0.005 &&
            ` · ${drift > 0 ? '+' : ''}${drift.toFixed(2)} from market moves on open positions`}
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
                    {d.edge >= 0 ? '+' : ''}
                    {d.edge.toFixed(2)}
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
