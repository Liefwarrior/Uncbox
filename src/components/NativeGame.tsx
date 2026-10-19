import { useEffect, useRef, useState } from 'react';
import { type HostWindow, send, shell, useCovered, useHole, useHostWindows, useShellMessages } from '../native';
import type { Crop, GameSettings } from '../state/model';

/** How often to look for the saved game's window while it isn't there yet (still starting up). */
const LOOK_EVERY_MS = 2000;

/**
 * "Play here": the game's own window sits in the game panel, in the Uncbox app. The panel
 * becomes a hole the game shows through, so mouse, keyboard and controller go straight to it.
 * The game is remembered, so it goes back in the panel when it or Uncbox starts again.
 *
 * follow, while set, takes over from the saved window without replacing it: the game Steam
 * started from Big Picture, found by its install folder. When it's gone, the saved one comes back.
 */
export function useNativeGame(
  on: boolean,
  saved: GameSettings['nativeGame'],
  remember: (game: GameSettings['nativeGame']) => void,
  follow: { dir: string } | null = null,
) {
  const [attached, setAttached] = useState<{ id: string; title: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [picture, setPicture] = useState<{ launchOption: string } | null>(null);
  useShellMessages((msg) => {
    if (msg.type === 'picture') setPicture(msg.on ? { launchOption: msg.launchOption } : null);
    if (msg.type === 'attached') {
      setAttached({ id: msg.id, title: msg.title });
      if (!follow && msg.process && (saved?.process !== msg.process || saved?.title !== msg.title)) {
        remember({ process: msg.process, title: msg.title });
      }
    } else if (msg.type === 'detached') {
      setAttached(null);
      setPicture(null);
    }
  });
  const windows = useHostWindows(on && (picking || !attached));

  // Switching to another source gives the game window back as it was.
  useEffect(() => {
    if (!on || !shell) return;
    return () => send({ type: 'detach' });
  }, [on]);

  // What belongs in the panel: the followed game, or the saved window.
  const target = follow ?? saved;
  const targetKey = follow ? `dir\n${follow.dir}` : saved ? `${saved.process}\n${saved.title}` : '';

  // When that changes (a game started or closed), give back what's there now.
  const lastTarget = useRef(targetKey);
  useEffect(() => {
    if (lastTarget.current === targetKey) return;
    lastTarget.current = targetKey;
    if (on && shell) send({ type: 'detach' });
  }, [on, targetKey]);

  // Until it's in the panel, keep looking for it: it may not be running yet.
  useEffect(() => {
    if (!on || !shell || !target || attached || picking) return;
    const look = () => send({ type: 'attach', match: target });
    look();
    const t = setInterval(look, LOOK_EVERY_MS);
    return () => clearInterval(t);
  }, [on, targetKey, attached, picking]);

  return {
    attached,
    /** Shown as a picture (the game won't be resized): no mouse, and how to fix that if known. */
    picture,
    saved,
    picking: picking || !attached,
    windows,
    attach: (w: HostWindow) => {
      send({ type: 'attach', id: w.id });
      setPicking(false);
    },
    pick: () => setPicking(true),
    /** Gives back what's in the panel and waits for this window instead (Steam's views). */
    switchTo: (match: NonNullable<GameSettings['nativeGame']>) => {
      send({ type: 'detach' });
      setPicking(false);
      remember(match);
    },
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
  if (showing) {
    return (
      <div
        ref={setHole}
        className="game-hole"
        // Shown as a picture, a click lands on Uncbox: hand the keyboard and controller back.
        onPointerDown={game.picture ? game.play : undefined}
      />
    );
  }
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
