import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLease, createShutdown } from './lifecycle.mjs';
import { createMedia } from './media.mjs';
import { createObs } from './obs.mjs';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createLease', () => {
  it('starts on the first ask, not again while asked, and stops once idle', () => {
    const start = vi.fn();
    const stop = vi.fn();
    const lease = createLease({ idleMs: 1000, start, stop });
    expect(lease.active).toBe(false);
    lease.touch();
    lease.touch();
    expect(start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lease.active).toBe(false);
  });

  it('each ask pushes the stop further out', () => {
    const stop = vi.fn();
    const lease = createLease({ idleMs: 1000, start: () => {}, stop });
    lease.touch();
    vi.advanceTimersByTime(800);
    lease.touch();
    vi.advanceTimersByTime(800);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('starts again when asked after it stopped', () => {
    const start = vi.fn();
    const lease = createLease({ idleMs: 1000, start, stop: () => {} });
    lease.touch();
    vi.advanceTimersByTime(1000);
    lease.touch();
    expect(start).toHaveBeenCalledTimes(2);
    expect(lease.active).toBe(true);
  });

  it('close stops it now, once, and cancels the timer', () => {
    const stop = vi.fn();
    const lease = createLease({ idleMs: 1000, start: () => {}, stop });
    lease.close();
    expect(stop).not.toHaveBeenCalled();
    lease.touch();
    lease.close();
    lease.close();
    vi.advanceTimersByTime(5000);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// ---- the media helper, with a stand-in for the PowerShell process ----

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn(() => queueMicrotask(() => child.emit('exit')));
  return child;
}

function mediaSetup(extra = {}) {
  const children = [];
  const spawnHelper = vi.fn(() => {
    const c = fakeChild();
    children.push(c);
    return c;
  });
  const sendJson = vi.fn();
  const handle = createMedia({
    broadcastEvent: () => {},
    isLocal: () => true,
    sendJson,
    readJson: async (req) => req.body,
    appName: (x) => x,
    idleMs: 90_000,
    platform: 'win32',
    spawnHelper,
    ...extra,
  });
  const ask = (pathname, req = {}) => handle(req, {}, new URL(`http://x${pathname}`));
  return { children, spawnHelper, sendJson, handle, ask };
}

describe('the media helper', () => {
  it('starts on demand, stops after idle, and starts again', async () => {
    const { children, spawnHelper, ask } = mediaSetup();
    expect(spawnHelper).not.toHaveBeenCalled();

    await ask('/api/media');
    expect(spawnHelper).toHaveBeenCalledTimes(1);

    // Still asked for every 30 s, so it stays.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await ask('/api/media');
    }
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(children[0].kill).not.toHaveBeenCalled();

    // Nobody asks any more.
    await vi.advanceTimersByTimeAsync(89_000);
    expect(children[0].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children[0].kill).toHaveBeenCalledTimes(1);

    // The next ask brings a fresh one.
    await ask('/api/media');
    expect(spawnHelper).toHaveBeenCalledTimes(2);
    expect(children[1].kill).not.toHaveBeenCalled();
  });

  it('forgets what it knew, so the music it last saw is not shown as current', async () => {
    const { children, spawnHelper, ask, sendJson } = mediaSetup();
    await ask('/api/media');
    const onLine = spawnHelper.mock.calls[0][0];
    onLine(JSON.stringify({ playing: true, title: 'Song', app: 'x', at: Date.now(), controls: {} }));
    await ask('/api/media');
    expect(sendJson.mock.lastCall[2].title).toBe('Song');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(children[0].kill).toHaveBeenCalled();
    await ask('/api/media');
    expect(sendJson.mock.lastCall[2].playing).toBe(false);
  });

  it('starts a fresh helper if the old one died on its own', async () => {
    const { children, spawnHelper, ask } = mediaSetup();
    await ask('/api/media');
    children[0].emit('exit');
    await ask('/api/media');
    expect(spawnHelper).toHaveBeenCalledTimes(2);
  });

  it('controls only reach a running helper, and keep it alive', async () => {
    const { children, ask, sendJson } = mediaSetup();
    await ask('/api/media/control', { method: 'POST', body: { action: 'toggle' } });
    expect(sendJson.mock.lastCall[1]).toBe(409);
    await ask('/api/media');
    await vi.advanceTimersByTimeAsync(60_000);
    await ask('/api/media/control', { method: 'POST', body: { action: 'toggle' } });
    expect(children[0].stdin.write).toHaveBeenCalledWith('{"action":"toggle"}\n');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[0].kill).not.toHaveBeenCalled();
  });

  it('does nothing off Windows', async () => {
    const { spawnHelper, ask } = mediaSetup({ platform: 'linux' });
    await ask('/api/media');
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it('close() kills the helper (shutting down)', async () => {
    const { children, ask, handle } = mediaSetup();
    await ask('/api/media');
    handle.close();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    handle.close();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });
});

// ---- the OBS connection ----

class FakeWebSocket {
  static instances = [];
  constructor() {
    this.listeners = {};
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send() {}
  close(code) {
    this.closed = true;
    this.listeners.close?.forEach((f) => f({ code }));
  }
}

describe('the OBS connection', () => {
  it('connects when asked, lets go after idle (no more retries), and connects again', async () => {
    FakeWebSocket.instances = [];
    const handle = createObs({
      broadcastEvent: () => {},
      sendJson: () => {},
      isLocal: () => true,
      readJson: async () => ({}),
      dataDir: '/nonexistent-uncbox-test',
      WebSocketImpl: FakeWebSocket,
      idleMs: 90_000,
    });
    const ask = () => handle({ method: 'GET' }, {}, new URL('http://x/api/obs'));
    await ask();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(90_000);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    // OBS being closed would normally make it retry every few seconds; it doesn't now.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await ask();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    handle.close();
    expect(FakeWebSocket.instances[1].closed).toBe(true);
  });
});

// ---- shutting down ----

describe('createShutdown', () => {
  const make = (extra = {}) => {
    const exit = vi.fn();
    const log = vi.fn();
    return { exit, log, shutdown: createShutdown({ exit, log, graceMs: 1000, ...extra }) };
  };

  it('stops the parts last added first, then exits', async () => {
    const { shutdown, exit } = make();
    const order = [];
    shutdown.add('helpers', () => order.push('helpers'));
    shutdown.add('saves', async () => order.push('saves'));
    shutdown.add('servers', () => order.push('servers'));
    await shutdown.run('test');
    expect(order).toEqual(['servers', 'saves', 'helpers']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('runs once however many times it is asked', async () => {
    const { shutdown, exit } = make();
    const fn = vi.fn();
    shutdown.add('a', fn);
    await Promise.all([shutdown.run('one'), shutdown.run('two')]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a part fails, and does not wait forever for one that hangs', async () => {
    const { shutdown, exit, log } = make();
    const last = vi.fn();
    shutdown.add('last', last);
    shutdown.add('hangs', () => new Promise(() => {}));
    shutdown.add('throws', () => {
      throw new Error('boom');
    });
    const done = shutdown.run('test');
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(last).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/couldn't stop throws: boom/);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/hangs took too long/);
  });

  it('a second Ctrl+C exits at once, even while a part is still stopping', async () => {
    const { shutdown, exit } = make();
    shutdown.add('slow', () => new Promise(() => {}));
    const proc = new EventEmitter();
    shutdown.install(proc);
    proc.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(10);
    expect(exit).not.toHaveBeenCalled();
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('SIGTERM stops everything and kills the helper process', async () => {
    const { shutdown, exit } = make();
    const { children, ask, handle } = mediaSetup();
    await ask('/api/media');
    shutdown.add('helpers', () => handle.close());
    const proc = new EventEmitter();
    shutdown.install(proc);
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(10);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
