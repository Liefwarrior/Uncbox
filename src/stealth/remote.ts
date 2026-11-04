import type { ShellMessage } from '../native';
import type { ControllerState } from '../stream/controller';

// The manager's stream controller. It runs no stream of its own: the dashboard's page keeps the one
// stream (its sound pipe, its retries), so Go live, Test stream and End stream here are handed to it
// through the app, and what it is doing comes back the same way. Two controllers would each try to
// bring back a dropped stream. Same shape as the real controller (src/stream/controller.ts), so
// everything that shows a stream works in either page.

const IDLE: ControllerState = { phase: 'idle', test: false, error: '', note: '', retries: 0, retryIn: null };

type Command = { type: 'streamcommand'; action: 'start' | 'test' | 'end' | 'state' };

export function createRemoteController(hand: (command: Command) => void) {
  let state: ControllerState = IDLE;
  const listeners = new Set<() => void>();
  let asked = false;

  /** Asks the dashboard how its stream is going, once someone wants to know. */
  const ask = () => {
    if (asked) return;
    asked = true;
    hand({ type: 'streamcommand', action: 'state' });
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      ask();
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async start(test: boolean) {
      hand({ type: 'streamcommand', action: test ? 'test' : 'start' });
    },
    async end() {
      hand({ type: 'streamcommand', action: 'end' });
    },
    async restart() {},
    /** The server's status reaches this page directly; what the controller makes of it comes from the dashboard. */
    onStatus() {},
    onShell(msg: ShellMessage) {
      if (msg.type !== 'streamstate' || !msg.state || typeof msg.state !== 'object') return;
      state = { ...IDLE, ...msg.state };
      listeners.forEach((l) => l());
    },
  };
}
