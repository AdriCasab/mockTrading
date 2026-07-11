import { GameState, cellKey } from '../engine/session';
import { Right, fmt } from '../engine/market';
import { Armed } from './Game';

export default function Chain({
  s, month, setMonth, armed, setArmed,
}: {
  s: GameState;
  month: number;
  setMonth: (m: number) => void;
  armed: Armed;
  setArmed: (a: Armed) => void;
}) {
  const env = s.env;

  const cell = (K: number, right: Right, side: 'bid' | 'ask') => {
    const q = s.quotes[cellKey(month, K, right)];
    if (!q) return <td className="empty">—</td>;
    const px = side === 'bid' ? q.bid : q.ask;
    const id = `${cellKey(month, K, right)}|${side}`;
    const verb = side === 'bid' ? 'Sell' : 'Buy';
    const name = `${env.months[month]} ${K} ${right === 'C' ? 'call' : 'put'}`;
    return (
      <td>
        <button
          className={`px ${armed?.id === id ? 'sel' : ''}`}
          onClick={() =>
            setArmed({
              id,
              label: `${verb} the ${name} at ${fmt(px)}`,
              action: { type: 'board', m: month, K, right, side },
            })
          }
        >
          {fmt(px)}
        </button>
      </td>
    );
  };

  return (
    <div className="card chainCard">
      {env.months.length > 1 && (
        <div className="tabs">
          {env.months.map((mo, i) => (
            <button key={mo} className={i === month ? 'tab on' : 'tab'} onClick={() => setMonth(i)}>
              {mo}
            </button>
          ))}
        </div>
      )}
      <table className="chain">
        <thead>
          <tr>
            <th colSpan={2}>calls</th>
            <th>strike</th>
            <th colSpan={2}>puts</th>
          </tr>
          <tr className="sub">
            <th>bid</th>
            <th>ask</th>
            <th />
            <th>bid</th>
            <th>ask</th>
          </tr>
        </thead>
        <tbody>
          {env.strikes.map((K) => (
            <tr key={K}>
              {cell(K, 'C', 'bid')}
              {cell(K, 'C', 'ask')}
              <td className="strike">{K}</td>
              {cell(K, 'P', 'bid')}
              {cell(K, 'P', 'ask')}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint dim">Tap a bid to sell it, an ask to buy it — hedge whenever you like.</p>
    </div>
  );
}
