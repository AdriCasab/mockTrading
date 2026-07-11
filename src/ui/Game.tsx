import { useEffect, useState } from 'react';
import { Action, GameState, isFlat, isRiskless, netDelta, pnl } from '../engine/session';
import { fmt, stockBid, stockAsk } from '../engine/market';
import Chain from './Chain';
import OrderRail from './OrderRail';
import Feed from './Feed';
import Blotter from './Blotter';

export type Armed = { id: string; label: string; action: Action; defaultSize?: number } | null;

export default function Game({ s, dispatch }: { s: GameState; dispatch: (a: Action) => void }) {
  const [armed, setArmed] = useState<Armed>(null);
  const [armedSize, setArmedSize] = useState(1);
  const [left, setLeft] = useState(s.cfg.shotClock);
  useEffect(() => setArmed(null), [s.round]);
  useEffect(() => setArmedSize(armed?.defaultSize ?? 1), [armed?.id, armed?.defaultSize]);

  useEffect(() => {
    if (!s.cfg.shotClock) return;
    setLeft(s.cfg.shotClock);
    const id = setInterval(() => setLeft((x) => x - 1), 1000);
    return () => clearInterval(id);
  }, [s.round, s.cfg.shotClock]);

  useEffect(() => {
    if (s.cfg.shotClock && left <= 0) dispatch({ type: 'tick' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const score = pnl(s);
  const flat = isFlat(s);
  const locked = !flat && isRiskless(s);
  const d = netDelta(s);
  const bid = stockBid(s.env);
  const ask = stockAsk(s.env);
  const hedgeSize = Math.min(99, Math.max(1, Math.round(Math.abs(d))));

  return (
    <div className="app">
      <header className="topbar">
        <div className="stockQuote">
          <span className="dim">stock</span>
          <button
            className={`px ${armed?.id === 'stock|bid' ? 'sel' : ''}`}
            onClick={() =>
              setArmed({
                id: 'stock|bid', label: `Sell stock at ${fmt(bid)}`,
                action: { type: 'stock', side: 'bid' }, defaultSize: hedgeSize,
              })
            }
          >
            {fmt(bid)}
          </button>
          <span className="dim">@</span>
          <button
            className={`px ${armed?.id === 'stock|ask' ? 'sel' : ''}`}
            onClick={() =>
              setArmed({
                id: 'stock|ask', label: `Buy stock at ${fmt(ask)}`,
                action: { type: 'stock', side: 'ask' }, defaultSize: hedgeSize,
              })
            }
          >
            {fmt(ask)}
          </button>
        </div>
        <div className="chips">
          <span className="chip">r/c {s.env.rc.map((x) => x.toFixed(2)).join(' / ')}</span>
          <span className="chip">
            tick {Math.min(s.round, s.cfg.rounds)}/{s.cfg.rounds}
          </span>
          <span className={`chip ${flat || locked ? 'pos' : ''}`}>
            {flat ? '🔒 flat' : locked ? '🔒 locked' : `Δ ${d >= 0 ? '+' : ''}${d.toFixed(2)}`}
          </span>
          <span className={`chip ${score >= 0 ? 'pos' : 'neg'}`}>
            {score >= 0 ? '+' : ''}
            {score.toFixed(2)}
          </span>
          {s.cfg.shotClock ? (
            <span className={`chip ${left <= 3 ? 'neg' : ''}`}>next tick {Math.max(left, 0)}s</span>
          ) : (
            <button className="chipBtn" onClick={() => dispatch({ type: 'tick' })}>
              Next tick →
            </button>
          )}
        </div>
      </header>

      {armed && (
        <div className="armedBar">
          <span>
            {armed.label} ×{armedSize}?
          </span>
          {[1, 5, 10, 20].map((v) => (
            <button
              key={v}
              className={`sizeChip ${armedSize === v ? 'on' : ''}`}
              onClick={() => setArmedSize(v)}
            >
              {v}
            </button>
          ))}
          <button
            className="primary"
            onClick={() => {
              dispatch({ ...armed.action, size: armedSize } as Action);
              setArmed(null);
            }}
          >
            Confirm
          </button>
          <button onClick={() => setArmed(null)}>Cancel</button>
        </div>
      )}

      <div className="cols">
        <section>
          <Chain s={s} armed={armed} setArmed={setArmed} />
          <Blotter s={s} />
        </section>
        <aside>
          <OrderRail s={s} dispatch={dispatch} />
          <Feed items={s.feed} />
        </aside>
      </div>
    </div>
  );
}
