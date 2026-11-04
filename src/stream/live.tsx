import { useEffect, useRef, useSyncExternalStore } from 'react';
import { saveClip } from '../clips/replay';
import { send, shell, useShellMessages } from '../native';
import { defaultState } from '../state/hydrate';
import type { StreamSettings } from '../state/model';
import { createRemoteController } from '../stealth/remote';
import { currentScene, isManagerView, relay, StealthListener, useStealth, useStealthScene } from '../stealth/stealth';
import { createSceneSync } from '../stealth/sync';
import { sendStreamScene, startStream, stopStream } from './api';
import { type ControllerState, createStreamController, type StreamController } from './controller';
import { isStreaming, useStream } from './status';

// The one stream controller for the page, and the component that feeds it. The controller does
// not live in the sidebar: the sidebar's sections can be shut or unmounted, and a dropped stream
// still has to be started again.
//
// In stealth mode's manager window (src/stealth) the controller is a stand-in that hands Go live
// and End stream to the dashboard's page, which keeps the only real one.

let latest: StreamSettings | null = null;

const real = () => {
  const ctl = createStreamController({
    hasShell: Boolean(shell),
    send,
    api: {
      start: (body) => {
        // What this stream starts with is what it shows: the scene sync only sends changes after this.
        sceneSync.started(body.scene ?? null);
        return startStream(body);
      },
      stop: stopStream,
    },
    settings: () => (latest ??= defaultState().stream),
    scene: currentScene,
  });
  return ctl;
};

export const controller: StreamController = isManagerView() ? createRemoteController((command) => relay(command)) : real();

/** Stealth mode's scene, kept current on a stream that is going (see src/stealth/sync.ts). */
const sceneSync = createSceneSync({
  current: currentScene,
  post: sendStreamScene,
  live: () => {
    const s = controller.getState();
    return s.phase === 'running' && s.retryIn === null;
  },
  restart: () => void controller.restart(),
});

/** Go live (or, with `test`, a test stream that Twitch takes but shows to no one). */
export const goLive = (settings: StreamSettings, test = false) => {
  latest = settings;
  return controller.start(test);
};

export const endStream = () => controller.end();

/** What the controller is doing: opening the sound, starting, waiting to try again, ending. */
export function useStreamController(): ControllerState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/**
 * Mounted once, in the app. Keeps the controller up to date with the settings, the server's
 * status and the app's messages, which is what lets it end a stream when the sound fails and
 * start a dropped one again. Draws nothing.
 */
export function StreamRunner({ settings }: { settings: StreamSettings }) {
  const status = useStream();
  useEffect(() => {
    latest = settings;
  }, [settings]);
  useEffect(() => {
    controller.onStatus(status);
  }, [status]);
  useShellMessages((msg) => controller.onShell(msg));
  if (!shell) return null;
  return (
    <>
      <StealthListener />
      {!isManagerView() && <StealthRunner settings={settings} live={isStreaming(status)} />}
    </>
  );
}

/**
 * The dashboard's part in stealth mode: stream mode comes on with it (the dashboard is what viewers
 * see), the scene follows the app's description while a stream is going, and the manager's Go live,
 * End stream and Save clip are done here, where the stream and the replay buffer are.
 */
function StealthRunner({ settings, live }: { settings: StreamSettings; live: boolean }) {
  const stealth = useStealth();
  const scene = useStealthScene();
  const latestSettings = useRef(settings);
  latestSettings.current = settings;

  // The dashboard is what viewers see in stealth mode, so its edit controls go.
  useEffect(() => {
    if (stealth) window.dispatchEvent(new CustomEvent(STEALTH_EVENT));
  }, [stealth]);

  useEffect(() => sceneSync.update(), [stealth, scene]);
  // Once a (re)started stream is going, anything that changed while it started goes out.
  useEffect(() => {
    if (live) sceneSync.poke();
  }, [live]);
  useEffect(() => () => sceneSync.dispose(), []);

  // The manager's page shows this controller's state, while there is a manager.
  useEffect(() => {
    if (!stealth) return;
    const tell = () => relay({ type: 'streamstate', state: controller.getState() });
    tell();
    return controller.subscribe(tell);
  }, [stealth]);

  useShellMessages((msg) => {
    if (msg.type === 'clipsave') void saveClip();
    if (msg.type !== 'streamcommand') return;
    if (msg.action === 'start' || msg.action === 'test') void goLive(latestSettings.current, msg.action === 'test');
    else if (msg.action === 'end') void endStream();
    else relay({ type: 'streamstate', state: controller.getState() });
  });
  return null;
}

/** Fired on the window when stealth mode comes on, so the app turns stream mode on. */
export const STEALTH_EVENT = 'uncbox:stealth';
