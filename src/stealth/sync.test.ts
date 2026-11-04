import { describe, expect, it, vi } from 'vitest';
import type { StealthScene } from '../native';
import { createSceneSync, THROTTLE_MS } from './sync';

// Keeping a running stream on stealth mode's scene: changes are sent while a stream is going, at
// most every THROTTLE_MS, and a stream FFmpeg runs (which can't show a scene) is started again.

const scene = (window: string, x = 0): StealthScene => ({ window, cursor: false, game: { window: '9', rect: { x, y: 0, w: 640, h: 360 }, crop: { top: 0, right: 0, bottom: 0, left: 0 }, stripPx: 0, fit: 'contain' } });

function setup({ applied = true, live = true } = {}) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const posted: (StealthScene | null)[] = [];
  const state = { live, applied, scene: null as StealthScene | null };
  const restart = vi.fn();
  const inner = createSceneSync({
    current: () => state.scene,
    post: async (s) => {
      posted.push(s);
      return { applied: state.applied };
    },
    live: () => state.live,
    restart,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  // The app describing a scene: the store changes, then the sync hears of it.
  const sync = {
    ...inner,
    update: (scene: StealthScene | null) => {
      state.scene = scene;
      inner.update();
    },
  };
  /** The pending send fires. */
  const fire = async () => {
    const t = timers.find((x) => x.live);
    if (!t) return false;
    t.live = false;
    t.fn();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    return true;
  };
  return { sync, posted, restart, fire, timers, state };
}

describe('the scene sync', () => {
  it('sends a change to a going stream once the throttle runs out, and only the newest of a drag', async () => {
    const t = setup();
    t.sync.update(scene('1'));
    t.sync.started(scene('1'));
    await t.fire();
    expect(t.posted).toEqual([]);
    t.sync.update(scene('1', 10));
    t.sync.update(scene('1', 20));
    t.sync.update(scene('1', 30));
    expect(t.timers.filter((x) => x.live)).toHaveLength(1);
    expect(t.timers.find((x) => x.live)!.ms).toBe(THROTTLE_MS);
    await t.fire();
    expect(t.posted).toEqual([scene('1', 30)]);
    // Nothing new, nothing sent.
    t.sync.update(scene('1', 30));
    await t.fire();
    expect(t.posted).toHaveLength(1);
  });

  it('tells a going stream that stealth mode ended, so it goes back to the screen', async () => {
    const t = setup();
    t.sync.update(scene('1'));
    t.sync.started(scene('1'));
    t.sync.update(null);
    await t.fire();
    expect(t.posted).toEqual([null]);
    expect(t.restart).not.toHaveBeenCalled();
  });

  it('sends nothing while no stream is going, and what changed once one is', async () => {
    const t = setup({ live: false });
    t.sync.update(scene('1'));
    await t.fire();
    expect(t.posted).toEqual([]);
    t.state.live = true;
    t.sync.poke();
    await t.fire();
    expect(t.posted).toEqual([scene('1')]);
  });

  it('leaves a stream that started with the scene alone', async () => {
    const t = setup();
    t.sync.update(scene('1'));
    t.sync.started(scene('1'));
    await t.fire();
    t.sync.poke();
    await t.fire();
    expect(t.posted).toEqual([]);
  });

  it('starts a stream FFmpeg runs again, once, when stealth mode comes on', async () => {
    const t = setup({ applied: false });
    t.sync.update(scene('1'));
    await t.fire();
    expect(t.restart).toHaveBeenCalledTimes(1);
    // A server that keeps saying no can't make it start over and over.
    t.sync.update(scene('1', 50));
    await t.fire();
    expect(t.restart).toHaveBeenCalledTimes(1);
    // Next stealth mode, again once.
    t.sync.update(null);
    await t.fire();
    t.sync.update(scene('2'));
    await t.fire();
    expect(t.restart).toHaveBeenCalledTimes(2);
  });

  it('never starts a stream again for going back to the screen', async () => {
    const t = setup({ applied: false });
    t.sync.update(scene('1'));
    t.sync.started(scene('1'));
    t.sync.update(null);
    await t.fire();
    expect(t.restart).not.toHaveBeenCalled();
  });

  it('a stream that starts as stealth mode comes on is told nothing it already has', async () => {
    const t = setup();
    // The store has the scene before the sync hears of it: the start reads the store.
    t.state.scene = scene('1');
    t.sync.started(scene('1'));
    await t.fire();
    t.sync.update(scene('1'));
    await t.fire();
    expect(t.posted).toEqual([]);
  });

  it('stops its timer when it goes', () => {
    const t = setup();
    t.sync.update(scene('1'));
    t.sync.dispose();
    expect(t.timers.every((x) => !x.live)).toBe(true);
  });
});
