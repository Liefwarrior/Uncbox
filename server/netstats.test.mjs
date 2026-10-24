// Ping and frame-rate numbers: the maths, the game's CSV, the target text, and that the timers
// start and stop with the widgets. Nothing here touches the network, a game or the real clock.

import { EventEmitter } from 'node:events';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNetstats, createSampler, lowPercentFps, parsePexRows, parseTarget, readGame, summarize, summarizeGame, tcpPing } from './netstats.mjs';

describe('summarize', () => {
  it('averages, and reads the newest as last', () => {
    expect(summarize([10, 20, 30])).toMatchObject({ last: 30, avg: 20, loss: 0 });
  });

  it('measures jitter as the mean change between successive pings', () => {
    // |20-10| + |15-20| + |35-15| = 35, over 3 changes.
    expect(summarize([10, 20, 15, 35]).jitter).toBe(11.7);
    expect(summarize([40, 40, 40]).jitter).toBe(0);
  });

  it('counts lost pings as loss and leaves them out of the average and jitter', () => {
    const s = summarize([10, null, 30, null]);
    expect(s).toMatchObject({ last: null, avg: 20, loss: 50, jitter: 20 });
  });

  it('copes with no readings at all', () => {
    expect(summarize([])).toEqual({ last: null, avg: null, jitter: 0, loss: 0 });
    expect(summarize([null, null])).toMatchObject({ avg: null, loss: 100 });
  });
});

describe('lowPercentFps', () => {
  it('is the slowest frame rate when there are fewer than 100 readings', () => {
    expect(lowPercentFps([144, 140, 30, 150])).toBe(30);
  });

  it('averages the slowest 1% of a long run', () => {
    const run = [...Array(198).fill(100), 20, 40];
    expect(lowPercentFps(run)).toBe(30); // the worst 2 of 200
  });

  it('has nothing without readings', () => {
    expect(lowPercentFps([])).toBeNull();
  });
});

// The header is the real one from SMITE 2's PEX_Timeline log; the rows are made up.
const HEADER =
  'Timestamp,IgnoredForSummary,FrameTime,GameThreadTime,RenderThreadTime,RHIThreadTime,GPUTime,DeltaTime,GameThreadWaitTime,FlushLoadingTime,MemoryWS,MemoryVB,CPUProcess,CPUMachine,MemoryVRAM,TickCount,DelayedTickCount,LevelLoadCompleted,ConnectionCount,Ping,InPackets,OutPackets,TotalPackets,InPacketsLost,OutPacketsLost,TotalPacketsLost,InPacketLossPct,OutPacketLossPct,TotalPacketLossPct,PlayerControllerCount,AIControllerCount,PawnCount';
const row = ({ ignore = 0, frame = 5, gpu = 2.5, delta = 6.25, ping = 0 } = {}) =>
  `2026-01-01T00:00:00.000Z,${ignore},${frame},${frame},1,1,${gpu},${delta},3,0,4000,4000,200,0,1500,240,0,0,1,${ping},0,0,0,0,0,0,0,0,0,1,0,1`;

describe('parsePexRows', () => {
  it('turns the time between frames into a frame rate, and takes GPU time and ping', () => {
    expect(parsePexRows(HEADER, [row({ delta: 6.25, gpu: 2.54, ping: 38 })])).toEqual([{ fps: 160, gpuMs: 2.5, ping: 38 }]);
  });

  it('falls back to frame time when a log has no delta time', () => {
    const header = 'Timestamp,IgnoredForSummary,FrameTime,Ping';
    expect(parsePexRows(header, ['t,0,4,20'])).toEqual([{ fps: 250, gpuMs: null, ping: 20 }]);
  });

  it('skips loading rows, rows without a frame time and rows cut short', () => {
    const rows = parsePexRows(HEADER, [row({ ignore: 1, delta: 800 }), row({ frame: 0, delta: 0 }), row().slice(0, 40), row({ delta: 10 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].fps).toBe(100);
  });

  it('reads a ping of 0 (no server connection) as no ping', () => {
    expect(parsePexRows(HEADER, [row({ ping: 0 })])[0].ping).toBeNull();
  });

  it('copes with CRLF line ends and unknown files', () => {
    expect(parsePexRows(`${HEADER}\r`, [`${row()}\r`])).toHaveLength(1);
    expect(parsePexRows('a,b,c', ['1,2,3'])).toEqual([]);
  });
});

describe('summarizeGame', () => {
  it('shows the newest second, with the 1% low and histories over the last 60 seconds', () => {
    const rows = [...Array(70).fill({ fps: 144, gpuMs: 3, ping: 30 }), { fps: 48, gpuMs: 9, ping: null }, { fps: 120, gpuMs: 4, ping: 31 }];
    const g = summarizeGame('SMITE 2', rows);
    expect(g).toMatchObject({ name: 'SMITE 2', fps: 120, fpsLow: 48, gpuMs: 4, ping: 31 });
    expect(g.fpsHistory).toHaveLength(60);
    expect(g.pingHistory).toHaveLength(60);
  });

  it('has nothing for an empty log', () => {
    expect(summarizeGame('SMITE 2', [])).toBeNull();
  });
});

describe('parseTarget', () => {
  it('takes a host, with 443 unless a port is given', () => {
    expect(parseTarget('example.com')).toEqual({ host: 'example.com', port: 443, key: 'example.com:443' });
    expect(parseTarget('  1.1.1.1:53 ')).toEqual({ host: '1.1.1.1', port: 53, key: '1.1.1.1:53' });
    expect(parseTarget('game-server.eu.example.com:27015')?.port).toBe(27015);
  });

  it('takes an IPv6 address in brackets', () => {
    expect(parseTarget('[2606:4700:4700::1111]:443')?.host).toBe('2606:4700:4700::1111');
    expect(parseTarget('[::1]')?.port).toBe(443);
  });

  it('uses the default for nothing', () => {
    expect(parseTarget('')?.key).toBe('1.1.1.1:443');
    expect(parseTarget(null)?.key).toBe('1.1.1.1:443');
  });

  it.each([
    ['two words', 'not a host'],
    ['a url', 'https://example.com/path'],
    ['a path', 'example.com/x'],
    ['credentials', 'me@example.com'],
    ['port 0', 'example.com:0'],
    ['a port too big', 'example.com:70000'],
    ['an empty port', 'example.com:'],
    ['a bare IPv6 address', '::1'],
    ['a bad bracket', '[not-ip]:443'],
    ['an empty label', 'a..b'],
    ['a leading dash', '-bad.example.com'],
    ['a shell trick', 'example.com;rm -rf'],
  ])('rejects %s', (_, text) => {
    expect(parseTarget(text)).toBeNull();
  });
});

/** A socket that connects (or fails) when the test says so. */
function fakeSocket() {
  const s = new EventEmitter();
  s.destroy = vi.fn();
  return s;
}

describe('tcpPing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('times how long the connection takes', async () => {
    const socket = fakeSocket();
    let t = 100;
    const p = tcpPing({ host: 'h', port: 443 }, { connect: () => socket, now: () => t });
    t = 142.34;
    socket.emit('connect');
    expect(await p).toBe(42.3);
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('counts a refused connection as an answer', async () => {
    const socket = fakeSocket();
    let t = 0;
    const p = tcpPing({ host: 'h', port: 443 }, { connect: () => socket, now: () => t });
    t = 3;
    socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    expect(await p).toBe(3);
  });

  it('loses the ping on other errors and after a second of silence', async () => {
    const broken = fakeSocket();
    const p1 = tcpPing({ host: 'h', port: 443 }, { connect: () => broken, now: () => 0 });
    broken.emit('error', Object.assign(new Error('unreachable'), { code: 'ENETUNREACH' }));
    expect(await p1).toBeNull();

    const silent = fakeSocket();
    const p2 = tcpPing({ host: 'h', port: 443 }, { connect: () => silent, now: () => 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p2).toBeNull();
    expect(silent.destroy).toHaveBeenCalled();
  });
});

describe('the sampler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A sampler whose connections all succeed instantly, counting how many were opened. */
  function setup() {
    const opened = [];
    const connect = vi.fn((opts) => {
      opened.push(opts);
      const s = fakeSocket();
      queueMicrotask(() => s.emit('connect'));
      return s;
    });
    const broadcast = vi.fn();
    const sampler = createSampler({ broadcast, connect, now: () => 0, gateway: async () => '192.168.1.1', game: async () => null });
    return { opened, connect, broadcast, sampler };
  }
  const target = parseTarget('example.com');

  it('does nothing until someone subscribes', async () => {
    const { connect, broadcast, sampler } = setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connect).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(sampler.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pings every 2 seconds and pushes once a second while subscribed', async () => {
    const { connect, broadcast, sampler } = setup();
    sampler.subscribe(target);
    await vi.advanceTimersByTimeAsync(6000);
    expect(connect).toHaveBeenCalledTimes(4); // at 0, 2, 4 and 6 s
    expect(broadcast).toHaveBeenCalledTimes(6);
    const snap = broadcast.mock.calls.at(-1)[0];
    expect(snap.targets['example.com:443']).toMatchObject({ last: 0, loss: 0 });
    expect(snap.targets['example.com:443'].history).toHaveLength(4);
    expect(snap.router).toBeNull();
  });

  it('leaves no timers running after the last unsubscribe', async () => {
    const { connect, broadcast, sampler } = setup();
    const stopA = sampler.subscribe(target);
    const stopB = sampler.subscribe(parseTarget('other.example.com:8443'));
    await vi.advanceTimersByTimeAsync(2000);
    stopA();
    expect(sampler.running).toBe(true);
    stopB();
    expect(sampler.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const calls = connect.mock.calls.length;
    const pushes = broadcast.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(connect.mock.calls.length).toBe(calls);
    expect(broadcast.mock.calls.length).toBe(pushes);
  });

  it('measures one host once however many widgets ask, and stops it when they all leave', async () => {
    const { connect, sampler } = setup();
    const a = sampler.subscribe(target);
    const b = sampler.subscribe(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    a();
    a(); // a second call to the same stop does nothing
    expect(sampler.running).toBe(true);
    b();
    expect(sampler.running).toBe(false);
  });

  it('measures the router only while a widget wants it', async () => {
    const { opened, sampler } = setup();
    const stop = sampler.subscribe(target, { withRouter: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(opened.map((o) => o.host)).toEqual(['example.com', '192.168.1.1']);
    expect(sampler.snapshot().router).toMatchObject({ host: '192.168.1.1', last: 0 });
    stop();
    expect(sampler.snapshot().router).toBeNull();
  });

  it('sends the game along with the pings', async () => {
    const game = vi.fn(async () => ({ name: 'SMITE 2', fps: 144 }));
    const broadcast = vi.fn();
    const sampler = createSampler({ broadcast, connect: () => fakeSocket(), now: () => 0, game });
    const stop = sampler.subscribe(target);
    await vi.advanceTimersByTimeAsync(1000);
    expect(broadcast.mock.calls.at(-1)[0].game).toEqual({ name: 'SMITE 2', fps: 144 });
    stop();
    expect(sampler.snapshot().game).toBeNull();
  });
});

describe('the route', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  let stop;

  function route(local = true) {
    stop = vi.fn();
    const sampler = { subscribe: vi.fn(() => stop), snapshot: () => ({ at: 1, targets: {}, router: null, game: null }) };
    const sendJson = vi.fn();
    const handle = createNetstats({ isLocal: () => local, sendJson, sampler });
    const ask = (query) => handle({}, {}, new URL(`http://x/api/netstats?${query}`));
    return { sampler, sendJson, ask };
  }

  it('refuses other devices and junk targets', () => {
    const other = route(false);
    other.ask('target=example.com');
    expect(other.sendJson).toHaveBeenCalledWith({}, 403, expect.any(Object));
    expect(other.sampler.subscribe).not.toHaveBeenCalled();

    const junk = route();
    junk.ask('target=not%20a%20host');
    expect(junk.sendJson).toHaveBeenCalledWith({}, 400, expect.any(Object));
    expect(junk.sampler.subscribe).not.toHaveBeenCalled();
  });

  it('keeps a lease alive while asked, and lets go soon after it stops', async () => {
    const { sampler, sendJson, ask } = route();
    ask('target=example.com&router=1');
    expect(sendJson).toHaveBeenCalledWith({}, 200, expect.objectContaining({ key: 'example.com:443' }));
    expect(sampler.subscribe).toHaveBeenCalledWith(expect.objectContaining({ key: 'example.com:443' }), { withRouter: true });
    await vi.advanceTimersByTimeAsync(5000);
    ask('target=example.com&router=1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sampler.subscribe).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readGame', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-pex-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const game = (now) => ({ games: [{ name: 'SMITE 2', dir: () => dir, file: /^PEX_Timeline_.*\.csv$/ }], now: () => now });
  const csv = (...rows) => [HEADER, ...rows].join('\n') + '\n';

  it('reads the newest log that changed in the last 10 seconds', async () => {
    const old = path.join(dir, 'PEX_Timeline_old.csv');
    const live = path.join(dir, 'PEX_Timeline_live.csv');
    await writeFile(old, csv(row({ delta: 50 })));
    await writeFile(live, csv(row({ ignore: 1, delta: 900 }), row({ delta: 8, ping: 25 }), row({ delta: 10, ping: 27 })));
    const now = Date.now();
    await utimes(old, (now - 3000) / 1000, (now - 3000) / 1000);
    await utimes(live, (now - 1000) / 1000, (now - 1000) / 1000);
    expect(await readGame(game(now))).toMatchObject({ name: 'SMITE 2', fps: 100, ping: 27, fpsLow: 100 });
  });

  it('shows no game when the log has gone quiet or nothing is installed', async () => {
    const file = path.join(dir, 'PEX_Timeline_a.csv');
    await writeFile(file, csv(row()));
    const now = Date.now();
    await utimes(file, (now - 60_000) / 1000, (now - 60_000) / 1000);
    expect(await readGame(game(now))).toBeNull();
    expect(await readGame({ games: [{ name: 'X', dir: () => path.join(dir, 'missing'), file: /./ }], now: () => now })).toBeNull();
    expect(await readGame({ games: [{ name: 'X', dir: () => null, file: /./ }] })).toBeNull();
  });

  it('only reads the end of a long log', async () => {
    const file = path.join(dir, 'PEX_Timeline_long.csv');
    await writeFile(file, csv(...Array(400).fill(row({ delta: 5 })), row({ delta: 20 })));
    const g = await readGame(game(Date.now()));
    expect(g.fps).toBe(50);
    expect(g.fpsHistory.length).toBeLessThanOrEqual(60);
  });
});
