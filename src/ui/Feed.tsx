import { FeedItem } from '../engine/session';

const WHO: Record<FeedItem['who'], string> = {
  inst: 'INST',
  crowd: 'CROWD',
  you: 'YOU',
  game: '·',
};

export default function Feed({ items }: { items: FeedItem[] }) {
  return (
    <div className="card feedCard">
      <h2>Tape</h2>
      <ul className="feed">
        {items.slice(0, 10).map((f, i) => (
          <li key={`${f.round}-${items.length - i}`} className={`who-${f.who}`}>
            <span className="badge">{WHO[f.who]}</span>
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
