import { describe, expect, it, vi } from 'vitest';
import { createRemoteController } from './remote';

// The manager's stand-in for the stream controller: it hands everything to the dashboard's page and
// shows what that one says, so there is only ever one controller keeping the stream going.

describe('the manager’s stream controller', () => {
  it('asks the dashboard how its stream is going once someone is listening', () => {
    const hand = vi.fn();
    const c = createRemoteController(hand);
    expect(hand).not.toHaveBeenCalled();
    c.subscribe(() => {});
    c.subscribe(() => {});
    expect(hand.mock.calls).toEqual([[{ type: 'streamcommand', action: 'state' }]]);
  });

  it('hands Go live, Test stream and End stream to the dashboard', async () => {
    const hand = vi.fn();
    const c = createRemoteController(hand);
    await c.start(false);
    await c.start(true);
    await c.end();
    expect(hand.mock.calls.map(([m]) => m.action)).toEqual(['start', 'test', 'end']);
    // It never starts anything again on its own.
    await c.restart();
    expect(hand).toHaveBeenCalledTimes(3);
  });

  it('shows the dashboard controller’s state, and nothing else', () => {
    const c = createRemoteController(() => {});
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.getState().phase));
    expect(c.getState().phase).toBe('idle');
    c.onShell({ type: 'streamstate', state: { phase: 'running', test: true, error: '', note: '', retries: 0, retryIn: null } });
    expect(c.getState()).toMatchObject({ phase: 'running', test: true });
    c.onShell({ type: 'stealth', on: true });
    c.onShell({ type: 'streamstate', state: null as never });
    c.onStatus();
    expect(seen).toEqual(['running']);
  });
});
