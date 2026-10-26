import { useEffect, useSyncExternalStore } from 'react';
import { send, shell, useShellMessages } from '../native';
import { defaultState } from '../state/hydrate';
import type { StreamSettings } from '../state/model';
import { startStream, stopStream } from './api';
import { type ControllerState, createStreamController } from './controller';
import { useStream } from './status';

// The one stream controller for the page, and the component that feeds it. The controller does
// not live in the sidebar: the sidebar's sections can be shut or unmounted, and a dropped stream
// still has to be started again.

let latest: StreamSettings | null = null;

export const controller = createStreamController({
  hasShell: Boolean(shell),
  send,
  api: { start: startStream, stop: stopStream },
  settings: () => (latest ??= defaultState().stream),
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
  return null;
}
