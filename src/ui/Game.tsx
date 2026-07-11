import { useEffect, useState } from 'react';
import { Action, GameState, pnl } from '../engine/session';
import { fmt, stockBid, stockAsk } from '../engine/market';
import Chain from './Chain';
import Prompt from './Prompt';
import Feed from './Feed';
import Blotter from './Blotter';

export type Armed = { id: string; label: string; action: Action } | null;

export default function Game({ s, dispatch }: { s: GameState; dispatch: (a: Action) => void }) {
  const [month, setMonth] = useState(0);
  const [armed, setArmed] = useState<Armed>(null);
  useEffect(() => setArmed(null), [s.round]);

  const score = pnl(s);
  const bid = stockBid(s.env);
  const ask = stockAsk(s.env);

  return (
    <div className="app">
      <header className="topbar">
        <div className="stockQuote">
          <span className="dim">stock</span>
          <button
            className={`px ${armed?.id === 'stock|bid' ? 'sel' : ''}`}
            onClick={() =>
              setArmed({ id: 'stock|bid', label: `Sell stock at ${fmt(bid)}`, action: { type: 'stock', side: 'bid' } })
            }
          >
            {fmt(bid)}
          </button>
          <span className="dim">@</span>
          <button
            className={`px ${armed?.id === 'stock|ask' ? 'sel' : ''}`}
            onClick={() =>
              setArmed({ id: 'stock|ask', label: `Buy stock at ${fmt(ask)}`, action: { type: 'stock', side: 'ask' } })
            }
          >
            {fmt(ask)}
          </button>
        </div>
        <div className="chips">
          <span className="chip">r/c {s.env.rc.map((x) => x.toFixed(2)).join(' / ')}</span>
          <span className="chip">
            round {Math.min(s.round, s.cfg.rounds)}/{s.cfg.rounds}
          </span>
          <span className={`chip ${score >= 0 ? 'pos' : 'neg'}`}>
            {score >= 0 ? '+' : ''}
            {score.toFixed(2)}
          </span>
        </div>
      </header>

      {armed && (
        <div className="armedBar">
          <span>{armed.label}?</span>
          <button
            className="primary"
            onClick={() => {
              dispatch(armed.action);
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
          <Chain s={s} month={month} setMonth={setMonth} armed={armed} setArmed={setArmed} />
          <Blotter s={s} />
        </section>
        <aside>
          <Prompt s={s} dispatch={dispatch} />
          <Feed items={s.feed} />
        </aside>
      </div>
    </div>
  );
}
