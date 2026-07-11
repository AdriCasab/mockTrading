import { useState } from 'react';
import { Action, GameState, newSession, reduce } from '../engine/session';
import Setup from './Setup';
import Game from './Game';
import Debrief from './Debrief';

export default function App() {
  const [game, setGame] = useState<GameState | null>(null);
  if (!game) return <Setup onStart={(cfg) => setGame(newSession(cfg))} />;
  if (game.phase === 'debrief') return <Debrief s={game} onAgain={() => setGame(null)} />;
  const dispatch = (a: Action) => setGame((g) => (g ? reduce(g, a) : g));
  return <Game s={game} dispatch={dispatch} />;
}
