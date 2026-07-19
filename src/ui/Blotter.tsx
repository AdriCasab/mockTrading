import { useState } from 'react';
import { Action, GameState, bookRows, isFlat, isRiskless, netDelta } from '../engine/session';

export default function Blotter({ s, dispatch }: { s: GameState; dispatch: (a: Action) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const flat = isFlat(s);
  const locked = !flat && isRiskless(s);
  const rows = bookRows(s);
  const d = netDelta(s);
  const active = sel.filter((k) => rows.some((r) => r.key === k));

  const toggle = (key: string) =>
    setSel((xs) => (xs.includes(key) ? xs.filter((x) => x !== key) : [...xs, key]));

  return (
    <div className="card blotterCard">
      <h2>Position</h2>
      {flat ? (
        <p className="dim">Flat.</p>
      ) : (
        <>
          <ul className="posList">
            {rows.map((r) => (
              <li
                key={r.key}
                className={active.includes(r.key) ? 'sel' : ''}
                onClick={() => toggle(r.key)}
              >
                <span className={r.qty > 0 ? 'pos' : 'neg'}>{r.qty > 0 ? `+${r.qty}` : r.qty}</span>{' '}
                {r.label}
              </li>
            ))}
          </ul>
          {active.length > 0 && (
            <div className="rowButtons netButtons">
              <button
                className="primary"
                onClick={() => {
                  dispatch({ type: 'net', keys: active });
                  setSel([]);
                }}
              >
                Cancel out at fair
              </button>
              <button onClick={() => setSel([])}>Clear</button>
            </div>
          )}
          {locked ? (
            <>
              <p className="dim small">🔒 Locked — you're long the r/c, no market risk.</p>
              <button className="primary" onClick={() => dispatch({ type: 'unwind' })}>
                Trade out at fair
              </button>
            </>
          ) : (
            <p className="dim small">
              net delta ≈ {d > 0 ? '+' : ''}
              {d.toFixed(2)} · tap rows to pick offsetting legs, then cancel them out
            </p>
          )}
        </>
      )}
    </div>
  );
}
