import type { StealthScene } from '../native';

// Keeps a stream that is going showing stealth mode's scene (the dashboard's side; see stealth.ts).
//
// Every start takes the scene along by itself (the controller asks for currentScene()), so this
// only matters while a stream runs: the panel moved, the game changed, stealth mode came on or went
// off. Uncbox's own engine takes the change at once. FFmpeg can't show a scene, so a stream FFmpeg is
// running when stealth mode comes on is started again (on the engine), which takes a few seconds.
// While a panel is dragged the scene changes every frame; it is sent at most every THROTTLE_MS.

export const THROTTLE_MS = 120;

export interface SceneSyncDeps {
  /** The scene as the app describes it now (null outside stealth mode): the one place it is kept, which starts read too. */
  current: () => StealthScene | null;
  /** POST /api/stream/scene: whether the running stream took it, or null when the server didn't answer. */
  post: (scene: StealthScene | null) => Promise<{ applied: boolean } | null>;
  /** Whether a stream is going (not starting, not waiting to try again): only then is a change sent. */
  live: () => boolean;
  /** Starts the stream again, so it comes back on the engine with the scene. */
  restart: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const key = (scene: StealthScene | null) => JSON.stringify(scene);

export function createSceneSync({ current, post, live, restart, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t as number) }: SceneSyncDeps) {
  /** What the running stream was started with or was last told. */
  let shown = key(null);
  let timer: unknown = null;
  let restarting = false;

  async function flush() {
    timer = null;
    const scene = current();
    if (!live() || key(scene) === shown) return;
    shown = key(scene);
    const answer = await post(scene);
    // FFmpeg is streaming and can't show the scene: the stream starts again, on the engine. Only once
    // per stealth mode, so a server that keeps saying no can't restart it over and over.
    if (answer && !answer.applied && scene && live() && !restarting) {
      restarting = true;
      restart();
    }
  }

  function schedule() {
    if (timer === null) timer = setTimer(() => void flush(), THROTTLE_MS);
  }

  return {
    /** The app described a new scene (or stealth mode ended). */
    update() {
      if (!current()) restarting = false;
      schedule();
    },
    /** A stream started (or started again) with this scene: that is what it shows now. */
    started(scene: StealthScene | null) {
      shown = key(scene);
      // Anything that changed while it was starting goes out once it is going.
      schedule();
    },
    /** The stream is going now (or again): send what changed while it wasn't. */
    poke() {
      if (key(current()) !== shown) schedule();
    },
    dispose() {
      clearTimer(timer);
      timer = null;
    },
  };
}

export type SceneSync = ReturnType<typeof createSceneSync>;
