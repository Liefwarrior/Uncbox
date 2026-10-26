// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkStreamTools, startStream, streamKeyFromTwitch, stopStream } from './api';
import { elapsedText, liveLine, streamLine, toolsLine } from './format';
import { QUALITIES, qualityLabel, qualityOf, qualityValues } from './quality';
import { IDLE, isStreaming, readStatus, resetStreamStatusForTests } from './status';

describe('quality', () => {
  it('lists the choices in the order the sidebar shows them', () => {
    expect(QUALITIES.map((q) => q.label)).toEqual(['1080p60 · 6000', '1080p30 · 4500', '720p60 · 4500', '720p30 · 3000', 'Screen size']);
  });

  it('turns a choice into settings and back', () => {
    for (const q of QUALITIES) expect(qualityOf(qualityValues(q.id))).toBe(q.id);
    expect(qualityValues('720p30')).toEqual({ height: 720, fps: 30, kbps: 3000 });
    expect(qualityValues('screen').height).toBe(0);
  });

  it('knows a combination that is not in the list', () => {
    expect(qualityOf({ height: 1080, fps: 60, kbps: 5000 })).toBeNull();
    expect(qualityLabel({ height: 1080, fps: 60, kbps: 5000 })).toBe('1080p60 · 5000');
    expect(qualityLabel({ height: 0, fps: 30, kbps: 3000 })).toBe('Screen size 30 · 3000');
    expect(qualityLabel({ height: 720, fps: 60, kbps: 4500 })).toBe('720p60 · 4500');
  });
});

describe('the status line', () => {
  const NOW = 10_000_000;
  const running = { state: 'live' as const, test: false, startedAt: NOW - (3600 + 120 + 33) * 1000, stats: { fps: 60, kbps: 5900, dropped: 0, frames: 1, speed: 1 } };
  const ctl = { phase: 'running' as const, retries: 0, retryIn: null };

  it('counts time as minutes and seconds, then hours', () => {
    expect(elapsedText(0)).toBe('0:00');
    expect(elapsedText(5 * 60_000 + 12_000)).toBe('5:12');
    expect(elapsedText((3600 + 2 * 60 + 33) * 1000)).toBe('1:02:33');
    expect(elapsedText(-5)).toBe('0:00');
  });

  it('says live time, bitrate and dropped frames', () => {
    expect(liveLine(running, NOW)).toBe('● Live 1:02:33 · 5.9 Mbps · 0 dropped');
    expect(liveLine({ ...running, stats: { ...running.stats, kbps: 800, dropped: 12 } }, NOW)).toBe('● Live 1:02:33 · 800 kbps · 12 dropped');
  });

  it('calls a test stream a test', () => {
    expect(liveLine({ ...running, test: true }, NOW)).toMatch(/^● Test 1:02:33/);
  });

  it('has nothing to add before the first numbers', () => {
    expect(liveLine({ test: false, startedAt: NOW - 5000, stats: null }, NOW)).toBe('● Live 0:05');
  });

  it('says what is happening at each step', () => {
    expect(streamLine(running, ctl, NOW)).toBe('● Live 1:02:33 · 5.9 Mbps · 0 dropped');
    expect(streamLine({ ...running, state: 'starting' }, { ...ctl, phase: 'preparing' }, NOW)).toBe('Starting the stream…');
    expect(streamLine({ ...running, state: 'dropped' }, { ...ctl, retries: 2, retryIn: 4 }, NOW)).toBe('Lost the connection. Trying again in 4 s (try 2 of 5)');
    expect(streamLine({ ...running, state: 'dropped' }, { ...ctl, phase: 'preparing', retries: 2 }, NOW)).toBe('Reconnecting… (try 2 of 5)');
    expect(streamLine({ ...running, state: 'stopping' }, ctl, NOW)).toBe('Ending the stream…');
    expect(streamLine(running, { ...ctl, phase: 'ending' }, NOW)).toBe('Ending the stream…');
    expect(streamLine({ ...running, state: 'dropped' }, { ...ctl, phase: 'idle' }, NOW)).toBe('The stream dropped.');
  });
});

describe('what the check found', () => {
  const tools = { ffmpeg: true, version: '8.1.2', nvenc: true, ddagrab: true };

  it('waits for the answer before saying anything is missing', () => {
    expect(toolsLine(IDLE.tools, false).state).toBe('checking');
  });

  it('is ready with NVENC and ddagrab', () => {
    expect(toolsLine(tools, true)).toEqual({ state: 'ready', text: 'Ready: NVENC on your graphics card' });
  });

  it('points at the Downloads widget when FFmpeg is missing', () => {
    expect(toolsLine(IDLE.tools, true)).toEqual({ state: 'missing', text: 'FFmpeg isn’t installed: install it from the Downloads widget.' });
  });

  it('says when it cannot capture or encode', () => {
    expect(toolsLine({ ...tools, ddagrab: false }, true).state).toBe('unsupported');
    expect(toolsLine({ ...tools, nvenc: false }, true).text).toMatch(/NVENC/);
  });
});

describe('the status from the server', () => {
  it('reads one, with a missing part filled in', () => {
    expect(readStatus({ state: 'live', test: true, startedAt: 5, stats: null, error: '', key: { set: true, hint: 'abcd', source: 'twitch' } })).toMatchObject({ state: 'live', test: true, startedAt: 5, key: { set: true, hint: 'abcd', source: 'twitch' }, tools: IDLE.tools });
  });

  it('ignores anything else (an error body, nonsense)', () => {
    for (const junk of [null, undefined, 'x', {}, { error: 'Not found' }, { state: 'sideways' }]) expect(readStatus(junk), JSON.stringify(junk)).toBeNull();
  });

  it('counts starting, live and dropped as streaming, and nothing else', () => {
    expect(['off', 'starting', 'live', 'stopping', 'dropped', 'error'].filter((state) => isStreaming({ state: state as never }))).toEqual(['starting', 'live', 'dropped']);
    expect(isStreaming(null)).toBe(false);
  });
});

describe('the calls to the server', () => {
  const reply = (status: number, body: unknown) => vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  beforeEach(() => resetStreamStatusForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('start sends the pipe, the test flag and the settings', async () => {
    const fetch = reply(200, { ...IDLE, state: 'starting' });
    vi.stubGlobal('fetch', fetch);
    const body = { audioPipe: '\\\\.\\pipe\\uncbox-stream-audio-1a2b3c4d', test: true, settings: { screen: 1, fps: 30, height: 720, kbps: 4500 } };
    expect(await startStream(body)).toBe('');
    expect(fetch).toHaveBeenCalledWith('/api/stream/start', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
  });

  it('start says why it could not', async () => {
    vi.stubGlobal('fetch', reply(400, { error: 'Add your Twitch stream key first.' }));
    expect(await startStream({ test: false, settings: { screen: 0, fps: 60, height: 1080, kbps: 6000 } })).toBe('Add your Twitch stream key first.');
  });

  it('says so when Uncbox cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('failed'))));
    expect(await stopStream()).toMatch(/Couldn’t reach Uncbox/);
  });

  it('turns the Twitch key answers into plain words', async () => {
    vi.stubGlobal('fetch', reply(409, { code: 'needs-signin', error: 'x' }));
    expect(await streamKeyFromTwitch()).toBe('Sign in to Twitch again so Uncbox can read your stream key.');
    vi.stubGlobal('fetch', reply(401, { code: 'not-signed-in', error: 'x' }));
    expect(await streamKeyFromTwitch()).toMatch(/Sign in to Twitch first/);
    vi.stubGlobal('fetch', reply(502, { error: 'Twitch is having trouble right now. Try again in a minute.' }));
    expect(await streamKeyFromTwitch()).toBe('Twitch is having trouble right now. Try again in a minute.');
    vi.stubGlobal('fetch', reply(200, { ...IDLE }));
    expect(await streamKeyFromTwitch()).toBe('');
  });

  it('a check asks for a fresh look only when told to', async () => {
    const fetch = reply(200, { ...IDLE });
    vi.stubGlobal('fetch', fetch);
    await checkStreamTools();
    await checkStreamTools(true);
    expect(fetch.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string))).toEqual([{ force: false }, { force: true }]);
  });
});
