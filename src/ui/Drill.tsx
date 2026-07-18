import { useEffect, useRef, useState } from 'react';
import { DrillLevel, DrillQuestion, makeDrill } from '../engine/drill';

type Result = { correct: boolean; answer: number; given: number | null };

export default function Drill({ level, onExit }: { level: DrillLevel; onExit: () => void }) {
  const [qs, setQs] = useState<DrillQuestion[]>(() => makeDrill(Date.now() % 1000000, 15, level));
  const [i, setI] = useState(0);
  const [input, setInput] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [startAt, setStartAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const done = i >= qs.length;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => inputRef.current?.focus(), [i]);

  const secs = ((done ? now : now) - startAt) / 1000;
  const nCorrect = results.filter((r) => r.correct).length;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const given = parseFloat(input);
    const answer = qs[i].answer;
    const correct = isFinite(given) && Math.abs(given - answer) < 0.005;
    setResults((rs) => [...rs, { correct, answer, given: isFinite(given) ? given : null }]);
    setInput('');
    setI((x) => x + 1);
  };

  const restart = () => {
    setQs(makeDrill(Date.now() % 1000000, 15, level));
    setI(0);
    setResults([]);
    setInput('');
    setStartAt(Date.now());
  };

  if (done) {
    const bestKey = `mt-drill-best-${level}`;
    const best = Number(localStorage.getItem(bestKey) ?? Infinity);
    const perfect = nCorrect === qs.length;
    if (perfect && secs < best) localStorage.setItem(bestKey, String(Math.round(secs)));
    return (
      <div className="app setup">
        <h1>Parity drill · {level}</h1>
        <div className="card scoreCard">
          <p className={`score ${perfect ? 'pos' : ''}`}>
            {nCorrect}/{qs.length}
          </p>
          <p className="dim">
            in {secs.toFixed(0)}s · {(secs / qs.length).toFixed(1)}s per question
            {perfect && secs <= 25 && ' · pit-ready'}
            {perfect && secs > 25 && secs <= 60 && ' · getting there — SIG pace is 25s'}
          </p>
        </div>
        <div className="card">
          {qs.map((q, j) => (
            <div className="row histRow" key={j}>
              <span className={results[j].correct ? 'pos' : 'neg'}>{results[j].correct ? '✓' : '✗'}</span>
              <span className="dim small grow">{q.prompt}</span>
              <span className="small">
                {results[j].correct ? q.answer.toFixed(2) : `${results[j].given ?? '—'} → ${q.answer.toFixed(2)}`}
              </span>
            </div>
          ))}
        </div>
        <div className="rowButtons">
          <button className="primary big" onClick={restart}>Run it again</button>
          <button className="big" onClick={onExit}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app setup">
      <h1>Parity drill · {level}</h1>
      <p className="dim">
        Question {i + 1} of {qs.length} · {secs.toFixed(0)}s · {nCorrect} right
      </p>
      <div className="card">
        <p className="drillQ">{qs[i].prompt}</p>
        <form onSubmit={submit} className="mmRow">
          <input
            ref={inputRef}
            inputMode="decimal"
            placeholder="fair value"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
          />
          <button className="primary" type="submit">Enter</button>
        </form>
      </div>
      <button className="ghost" onClick={onExit}>Quit drill</button>
    </div>
  );
}
