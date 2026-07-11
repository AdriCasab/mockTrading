import { useState } from 'react';
import { Action, GameState } from '../engine/session';
import { fmtPx, legsText } from '../engine/products';
import { roundTick } from '../engine/market';

function MMCard({ s, dispatch }: { s: GameState; dispatch: (a: Action) => void }) {
  const [bid, setBid] = useState('');
  const [ask, setAsk] = useState('');
  const [err, setErr] = useState('');
  const mm = s.mm!;

  const submit = () => {
    const b = roundTick(parseFloat(bid));
    const a = roundTick(parseFloat(ask));
    if (!isFinite(b) || !isFinite(a)) return setErr('Enter both a bid and an ask.');
    if (b < 0) return setErr('Bid can’t be negative.');
    if (a <= b) return setErr('Ask must be above bid.');
    dispatch({ type: 'mm', bid: b, ask: a });
  };

  return (
    <div className="card promptCard">
      <p className="broker">Instructor · {mm.ttl} tick{mm.ttl === 1 ? '' : 's'} left</p>
      <p className="instLine">“Make me a market in the {mm.product.label}.”</p>
      <div className="mmRow">
        <input placeholder="bid" inputMode="decimal" value={bid} onChange={(e) => setBid(e.target.value)} />
        <span className="dim">at</span>
        <input placeholder="ask" inputMode="decimal" value={ask} onChange={(e) => setAsk(e.target.value)} />
        <button className="primary" onClick={submit}>Quote it</button>
      </div>
      {err && <p className="neg small">{err}</p>}
      <button className="ghost" onClick={() => dispatch({ type: 'pass' })}>Pass</button>
    </div>
  );
}

export default function OrderRail({ s, dispatch }: { s: GameState; dispatch: (a: Action) => void }) {
  return (
    <div className="rail">
      {s.mm && <MMCard key={`mm-${s.round}-${s.mm.product.label}`} s={s} dispatch={dispatch} />}
      {s.orders.map((o) => (
        <div className="card orderCard" key={o.id}>
          <p className="broker">
            {o.broker} · {o.ttl} tick{o.ttl === 1 ? '' : 's'} left
          </p>
          <p className="instLine">
            {o.side === 'bid'
              ? `“I'll pay ${fmtPx(o.product, o.price)} for the ${o.product.label}.”`
              : `“At ${fmtPx(o.product, o.price)}, I'm a seller of the ${o.product.label}.”`}
          </p>
          <button className="primary big" onClick={() => dispatch({ type: 'order', id: o.id })}>
            {o.side === 'bid' ? 'Hit it' : 'Take it'}
            <small>
              {o.side === 'bid' ? 'sell' : 'buy'} at {fmtPx(o.product, o.price)} —{' '}
              {legsText(s.env, o.product, o.side === 'bid' ? -1 : 1)}
            </small>
          </button>
        </div>
      ))}
      {!s.mm && s.orders.length === 0 && (
        <div className="card"><p className="dim">The pit is quiet — next tick.</p></div>
      )}
    </div>
  );
}
