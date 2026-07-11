import { GameState, netDelta } from '../engine/session';

export default function Blotter({ s }: { s: GameState }) {
  const opts = Object.entries(s.posOpt);
  const d = netDelta(s);
  const flat = !opts.length && !s.posStock;

  return (
    <div className="card blotterCard">
      <h2>Position</h2>
      {flat ? (
        <p className="dim">Flat.</p>
      ) : (
        <>
          <ul className="posList">
            {opts.map(([key, q]) => {
              const [m, K, right] = key.split('|');
              return (
                <li key={key}>
                  <span className={q > 0 ? 'pos' : 'neg'}>{q > 0 ? `+${q}` : q}</span>{' '}
                  {s.env.months[Number(m)]} {K}
                  {right}
                </li>
              );
            })}
            {s.posStock !== 0 && (
              <li>
                <span className={s.posStock > 0 ? 'pos' : 'neg'}>
                  {s.posStock > 0 ? `+${s.posStock}` : s.posStock}
                </span>{' '}
                stock
              </li>
            )}
          </ul>
          <p className="dim small">
            net delta ≈ {d > 0 ? '+' : ''}
            {d.toFixed(2)}
          </p>
        </>
      )}
    </div>
  );
}
