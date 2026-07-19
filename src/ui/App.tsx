import { useState } from 'react';
import { Action, GameState, newSession, reduce } from '../engine/session';
import { DrillLevel, DrillStyle } from '../engine/drill';
import Setup from './Setup';
import Game from './Game';
import Debrief from './Debrief';
import Drill from './Drill';

type Screen = { name: 'setup' } | { name: 'drill'; level: DrillLevel; style: DrillStyle };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'setup' });
  const [game, setGame] = useState<GameState | null>(null);

  if (game) {
    if (game.phase === 'debrief') return <Debrief s={game} onAgain={() => setGame(null)} />;
    const dispatch = (a: Action) => setGame((g) => (g ? reduce(g, a) : g));
    return <Game s={game} dispatch={dispatch} />;
  }
  if (screen.name === 'drill')
    return <Drill level={screen.level} style={screen.style} onExit={() => setScreen({ name: 'setup' })} />;
  return (
    <Setup
      onStart={(cfg) => setGame(newSession(cfg))}
      onDrill={(level, style) => setScreen({ name: 'drill', level, style })}
    />
  );
}
