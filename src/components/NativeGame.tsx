import { useEffect, useState } from 'react';
import { type HostWindow, send, shell, useCovered, useHole, useHostWindows, useShellMessages } from '../native';
import type { Crop, GameSettings } from '../state/model';

/** How often to look for the saved game's window while it isn't there yet (still starting up). */
const LOOK_EVERY_MS = 2000;

/**
 * "Play here": the game's own window sits in the game panel, in the Uncbox app. The panel
 * becomes a hole the game shows through, so mouse, keyboard and controller go straight to it.
 * The game is remembered, so it goes back in the panel when it or Uncbox starts again.
 */
export function useNativeGame(on: boolean, saved: GameSettings['nativeGame'], remember: (game: GameSettings['nativeGame']) => void) {
  const [attached, setAttached] = useState<{ id: string; title: string } | null>(null);
  const [picking, setPicking] = useState(false);
  useShellMessages((msg) => {
    if (msg.type === 'attached') {
      setAttached({ id: msg.id, title: msg.title });
      if (msg.process && (saved?.process !== msg.process || saved?.title !== msg.title)) remember({ process: msg.process, title: msg.title });
    } else if (msg.type === 'detached') setAttached(null);
  });
  const windows = useHostWindows(on && (picking || !attached));

  // Switching to another source gives the game window back as it was.
  useEffect(() => {
    if (!on || !shell) return;
    return () => send({ type: 'detach' });
  }, [on]);

  // Until the saved game is back in the panel, keep looking for it: it may not be running yet.
  const savedKey = saved ? `${saved.process}\n${saved.title}` : '';
  useEffect(() => {
    if (!on || !shell || !saved || attached || picking) return;
    const look = () => send({ type: 'attach', match: saved });
    look();
    const t = setInterval(look, LOOK_EVERY_MS);
    return () => clearInterval(t);
  }, [on, savedKey, attached, picking]);

  return {
    attached,
    saved,
    picking: picking || !attached,
    windows,
    attach: (w: HostWindow) => {
      send({ type: 'attach', id: w.id });
      setPicking(false);
    },
    pick: () => setPicking(true),
    cancelPick: () => setPicking(false),
    refresh: () => send({ type: 'windows' }),
    play: () => send({ type: 'play' }),
    fullScreen: () => send({ type: 'fullscreen' }),
  };
}

type NativeGameState = ReturnType<typeof useNativeGame>;

interface Props {
  game: NativeGameState;
  editing: boolean;
  crop: Crop;
  stripPx: number;
}

export function NativeGame({ game, editing, crop, stripPx }: Props) {
  const [hole, setHole] = useState<HTMLDivElement | null>(null);
  const covered = useCovered();
  const showing = Boolean(game.attached) && !game.picking;
  useHole(showing && !covered ? hole : null, crop, stripPx);

  if (!shell) {
    return editing ? (
      <div className="game-empty">
        <h3>Playing in the Uncbox app</h3>
        <p className="muted">Your game is in the panel on the PC running the Uncbox app. Pick another source to show it here.</p>
      </div>
    ) : null;
  }
  if (showing) return <div ref={setHole} className="game-hole" />;
  if (!editing) return null;
  return (
    <div className="game-empty">
      <h3>Which game?</h3>
      <p className="muted">
        {game.saved && !game.attached
          ? `Waiting for ${game.saved.title || game.saved.process}. Start it and it moves in here, or pick another.`
          : 'Run it windowed or borderless. It moves into this panel, and you play it right here.'}
      </p>
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
      <div className="row">
        <button className="btn" onClick={game.refresh}>
          Refresh
        </button>
        {game.attached && (
          <button className="btn" onClick={game.cancelPick}>
            Keep {game.attached.title}
          </button>
        )}
      </div>
    </div>
  );
}
