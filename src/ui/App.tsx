import { useState } from 'react';
import { Action, GameState, newSession, reduce } from '../engine/session';
import Setup from './Setup';
import Game from './Game';
import Debrief from './Debrief';
import Drill from './Drill';

type Screen = { name: 'setup' } | { name: 'drill' };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'setup' });
  const [game, setGame] = useState<GameState | null>(null);

  if (game) {
    if (game.phase === 'debrief') return <Debrief s={game} onAgain={() => setGame(null)} />;
    const dispatch = (a: Action) => setGame((g) => (g ? reduce(g, a) : g));
    return <Game s={game} dispatch={dispatch} />;
  }
  if (screen.name === 'drill') return <Drill onExit={() => setScreen({ name: 'setup' })} />;
  return (
    <Setup
      onStart={(cfg) => setGame(newSession(cfg))}
      onDrill={() => setScreen({ name: 'drill' })}
    />
  );
}
