import { useEffect, useState } from 'react';
import { Action, GameState } from '../engine/session';
import { fmtPx, legsText } from '../engine/products';
import { roundTick } from '../engine/market';

export default function Prompt({ s, dispatch }: { s: GameState; dispatch: (a: Action) => void }) {
  const pd = s.pending;
  const total = pd && s.cfg.shotClock ? (pd.kind === 'mm' ? s.cfg.shotClock * 2 : s.cfg.shotClock) : 0;
  const [left, setLeft] = useState(total);
  const [bid, setBid] = useState('');
  const [ask, setAsk] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    setLeft(total);
    setBid('');
    setAsk('');
    setErr('');
    if (!total) return;
    const id = setInterval(() => setLeft((x) => x - 1), 1000);
    return () => clearInterval(id);
  }, [s.round, total]);

  useEffect(() => {
    if (total && left <= 0 && pd)
      dispatch(pd.kind === 'mm' ? { type: 'pass', timeout: true } : { type: 'leave', timeout: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  if (!pd) return null;

  const submitMM = () => {
    const b = roundTick(parseFloat(bid));
    const a = roundTick(parseFloat(ask));
    if (!isFinite(b) || !isFinite(a)) return setErr('Enter both a bid and an ask.');
    if (b < 0) return setErr('Bid can’t be negative.');
    if (a <= b) return setErr('Ask must be above bid.');
    dispatch({ type: 'mm', bid: b, ask: a });
  };

  return (
    <div className="card promptCard">
      {total > 0 && (
        <div className="clock">
          <div
            className={`clockFill ${left <= 5 ? 'low' : ''}`}
            style={{ width: `${Math.max(0, (left / total) * 100)}%` }}
          />
        </div>
      )}
      {pd.kind === 'take' ? (
        <>
          <p className="instLine">
            {pd.side === 'bid'
              ? `Instructor: “I'm ${fmtPx(pd.product, pd.price)} bid for the ${pd.product.label}.”`
              : `Instructor: “I'm asking ${fmtPx(pd.product, pd.price)} for the ${pd.product.label}.”`}
          </p>
          <div className="actions">
            <button className="primary big" onClick={() => dispatch({ type: 'take' })}>
              {pd.side === 'bid' ? 'Hit it' : 'Take it'}
              <small>
                {pd.side === 'bid' ? 'sell' : 'buy'} at {fmtPx(pd.product, pd.price)} —{' '}
                {legsText(s.env, pd.product, pd.side === 'bid' ? -1 : 1)}
              </small>
            </button>
            <button className="big" onClick={() => dispatch({ type: 'leave' })}>
              Leave it
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="instLine">Instructor: “Make me a market in the {pd.product.label}.”</p>
          <div className="mmRow">
            <input
              placeholder="bid"
              inputMode="decimal"
              value={bid}
              onChange={(e) => setBid(e.target.value)}
            />
            <span className="dim">at</span>
            <input
              placeholder="ask"
              inputMode="decimal"
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
            />
            <button className="primary" onClick={submitMM}>
              Quote it
            </button>
          </div>
          {err && <p className="neg small">{err}</p>}
          <button className="ghost" onClick={() => dispatch({ type: 'pass' })}>
            Pass
          </button>
        </>
      )}
    </div>
  );
}
