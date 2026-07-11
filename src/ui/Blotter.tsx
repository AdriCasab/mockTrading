import { Action, GameState, isFlat, isRiskless, netDelta } from '../engine/session';

type Row = { label: string; q: number };

// Collapse each strike's long-call/short-put overlap into combos (synthetic
// stock), the way a trader reads a book, and list only the residual legs.
function bookRows(s: GameState): Row[] {
  const byStrike: Record<string, { c: number; p: number }> = {};
  for (const [key, q] of Object.entries(s.posOpt)) {
    const [m, K, right] = key.split('|');
    const kk = `${m}|${K}`;
    byStrike[kk] ??= { c: 0, p: 0 };
    if (right === 'C') byStrike[kk].c += q;
    else byStrike[kk].p += q;
  }
  const rows: Row[] = [];
  for (const kk of Object.keys(byStrike).sort()) {
    const [m, K] = kk.split('|');
    const { c, p } = byStrike[kk];
    const name = `${s.env.months[Number(m)]} ${K}`;
    let combos = 0;
    if (c > 0 && p < 0) combos = Math.min(c, -p);
    else if (c < 0 && p > 0) combos = -Math.min(-c, p);
    if (combos) rows.push({ label: `${name} combo`, q: combos });
    if (c - combos) rows.push({ label: `${name}C`, q: c - combos });
    if (p + combos) rows.push({ label: `${name}P`, q: p + combos });
  }
  if (s.posStock) rows.push({ label: 'stock', q: s.posStock });
  return rows;
}

export default function Blotter({ s, dispatch }: { s: GameState; dispatch: (a: Action) => void }) {
  const flat = isFlat(s);
  const locked = !flat && isRiskless(s);
  const rows = bookRows(s);
  const d = netDelta(s);

  return (
    <div className="card blotterCard">
      <h2>Position</h2>
      {flat ? (
        <p className="dim">Flat.</p>
      ) : (
        <>
          <ul className="posList">
            {rows.map((r) => (
              <li key={r.label}>
                <span className={r.q > 0 ? 'pos' : 'neg'}>{r.q > 0 ? `+${r.q}` : r.q}</span> {r.label}
              </li>
            ))}
          </ul>
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
              {d.toFixed(2)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
