import { useEffect, useState } from 'react';
import { type HostWindow, send, shell, useHole, useHostWindows, useShellMessages } from '../native';

/**
 * "Play here": the game's own window sits in the game panel, in the native shell. The panel
 * becomes a hole the game shows through, so mouse, keyboard and controller go straight to it.
 */
export function useNativeGame(on: boolean) {
  const [attached, setAttached] = useState<{ id: string; title: string } | null>(null);
  const [picking, setPicking] = useState(false);
  useShellMessages((msg) => {
    if (msg.type === 'attached') setAttached({ id: msg.id, title: msg.title });
    else if (msg.type === 'detached') setAttached(null);
  });
  const windows = useHostWindows(on && (picking || !attached));

  // Switching to another source gives the game window back as it was.
  useEffect(() => {
    if (!on || !shell) return;
    return () => send({ type: 'detach' });
  }, [on]);

  return {
    attached,
    picking: picking || !attached,
    windows,
    attach: (w: HostWindow) => {
      send({ type: 'attach', id: w.id });
      setPicking(false);
    },
    pick: () => setPicking(true),
    refresh: () => send({ type: 'windows' }),
    play: () => send({ type: 'play' }),
    fullScreen: () => send({ type: 'fullscreen' }),
  };
}

type NativeGameState = ReturnType<typeof useNativeGame>;

export function NativeGame({ game, editing }: { game: NativeGameState; editing: boolean }) {
  const [hole, setHole] = useState<HTMLDivElement | null>(null);
  const showing = Boolean(game.attached) && !game.picking;
  useHole(showing ? hole : null);

  if (!shell) {
    return editing ? (
      <div className="game-empty">
        <h3>Playing in the Uncbox app</h3>
        <p className="muted">Your game is in the panel on the PC running the Uncbox app. Pick another source to show it here.</p>
      </div>
    ) : null;
  }
  if (showing) return <div ref={setHole} className="game-hole" />;
  return (
    <div className="game-empty">
      <h3>Which game?</h3>
      <p className="muted">It moves into this panel, and you play it right here.</p>
      <ul className="window-list">
        {game.windows.map((w) => (
          <li key={w.id}>
            <button className="window-list__item" onClick={() => game.attach(w)}>
              <strong>{w.title}</strong>
              <small>{w.process}</small>
            </button>
          </li>
        ))}
      </ul>
      <button className="btn" onClick={game.refresh}>
        Refresh
      </button>
    </div>
  );
}
