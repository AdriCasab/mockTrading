import { GameState, cellKey } from '../engine/session';
import { Right, fmt } from '../engine/market';
import { Armed } from './Game';

export default function Chain({
  s, armed, setArmed,
}: {
  s: GameState;
  armed: Armed;
  setArmed: (a: Armed) => void;
}) {
  const env = s.env;

  const cell = (m: number, K: number, right: Right, side: 'bid' | 'ask') => {
    const q = s.quotes[cellKey(m, K, right)];
    if (!q) return <td className="empty">—</td>;
    const px = side === 'bid' ? q.bid : q.ask;
    const id = `${cellKey(m, K, right)}|${side}`;
    const verb = side === 'bid' ? 'Sell' : 'Buy';
    const name = `${env.months[m]} ${K} ${right === 'C' ? 'call' : 'put'}`;
    return (
      <td>
        <button
          className={`px ${armed?.id === id ? 'sel' : ''}`}
          onClick={() =>
            setArmed({
              id,
              label: `${verb} the ${name} at ${fmt(px)}`,
              action: { type: 'board', m, K, right, side },
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
      {env.months.map((mo, m) => (
        <div key={mo} className="monthChain">
          {env.months.length > 1 && <h2>{mo}</h2>}
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
                  {cell(m, K, 'C', 'bid')}
                  {cell(m, K, 'C', 'ask')}
                  <td className="strike">{K}</td>
                  {cell(m, K, 'P', 'bid')}
                  {cell(m, K, 'P', 'ask')}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="hint dim">Tap a bid to sell it, an ask to buy it — hedge whenever you like.</p>
    </div>
  );
}
