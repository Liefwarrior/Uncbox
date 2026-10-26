// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from '../state/hydrate';
import type { StreamSettings } from '../state/model';
import { endStream, StreamRunner } from '../stream/live';
import { IDLE, resetStreamStatusForTests, setStreamStatus, type StreamStatus } from '../stream/status';
import { GoLive, StreamSection } from './StreamSection';

// The sidebar's streaming controls with the Uncbox app (the native shell) played by the test:
// what the page sends it, and what it answers.

const shellMock = vi.hoisted(() => ({ listeners: new Set<(msg: unknown) => void>(), send: vi.fn() }));
vi.mock('../native', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    shell: {},
    send: shellMock.send,
    useShellMessages: (onMessage: (msg: unknown) => void) => {
      const latest = useRef(onMessage);
      useEffect(() => {
        latest.current = onMessage;
      });
      useEffect(() => {
        const fn = (msg: unknown) => latest.current(msg);
        shellMock.listeners.add(fn);
        return () => void shellMock.listeners.delete(fn);
      }, []);
    },
  };
});

const PIPE = '\\\\.\\pipe\\uncbox-stream-audio-1a2b3c4d';
const fromShell = (msg: unknown) => act(() => shellMock.listeners.forEach((l) => l(msg)));

const ready: StreamStatus = { ...IDLE, key: { set: true, hint: 'q9z7', source: 'pasted' }, tools: { ffmpeg: true, version: '8.1.2', nvenc: true, ddagrab: true } };
let current: StreamStatus = ready;
let calls: { route: string; body: unknown }[] = [];

function stubServer() {
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ route: path, body });
      if (path === '/api/stream/start') current = { ...current, state: 'starting', test: Boolean(body.test) };
      if (path === '/api/stream/stop') current = { ...current, state: 'off', test: false };
      if (path.startsWith('/api/ytdlp')) return new Response(JSON.stringify({ tools: null, install: { running: false, action: '', tool: '', lines: [], error: '' }, queue: [], history: [] }), { status: 200 });
      return new Response(JSON.stringify(current), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function Harness({ settings, set }: { settings: StreamSettings; set: (s: StreamSettings) => void }) {
  return (
    <>
      <StreamRunner settings={settings} />
      <GoLive settings={settings} />
      <StreamSection settings={settings} mutate={(recipe) => set((() => {
        const state = defaultState();
        state.stream = { ...settings };
        recipe(state);
        return state.stream;
      })())} />
    </>
  );
}

function setup(over: Partial<StreamSettings> = {}) {
  let settings: StreamSettings = { ...defaultState().stream, with: 'uncbox', mic: 'mic-1', ...over };
  const view = render(<Harness settings={settings} set={(s) => view.rerender(<Harness settings={(settings = s)} set={() => {}} />)} />);
  return { view, settings: () => settings };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('uncbox.sidebar.streaming', '1');
  shellMock.send.mockClear();
  shellMock.listeners.clear();
  calls = [];
  current = ready;
  resetStreamStatusForTests();
  stubServer();
});
afterEach(async () => {
  await act(async () => {
    await endStream();
  });
  cleanup();
  vi.unstubAllGlobals();
});

describe('the sound, with the app', () => {
  it('asks the app for the mics and lists them', async () => {
    setup();
    expect(shellMock.send).toHaveBeenCalledWith({ type: 'audiodevices' });
    await fromShell({ type: 'audiodevices', mics: [{ id: 'mic-1', name: 'Blue Yeti', isDefault: false }, { id: 'mic-2', name: 'Headset', isDefault: true }] });
    const mic = screen.getByLabelText('Mic') as HTMLSelectElement;
    expect([...mic.options].map((o) => o.textContent)).toEqual(['No mic', 'Default (Headset)', 'Blue Yeti', 'Headset']);
    expect(mic.value).toBe('mic-1');
  });

  it('says so when the chosen mic is not connected any more', async () => {
    setup({ mic: 'gone' });
    await fromShell({ type: 'audiodevices', mics: [{ id: 'mic-2', name: 'Headset', isDefault: true }] });
    const mic = screen.getByLabelText('Mic') as HTMLSelectElement;
    expect([...mic.options].map((o) => o.textContent)).toContain('That mic isn’t connected');
  });

  it('keeps the sound settings while a stream is not running, and has no volume for a source that is off', async () => {
    setup({ desktop: false, mic: null });
    expect(screen.queryByLabelText('Desktop volume')).toBeNull();
    expect(screen.queryByLabelText('Mic volume')).toBeNull();
    expect((screen.getByLabelText('Mic') as HTMLSelectElement).value).toBe('');
  });
});

describe('going live with the app', () => {
  async function pressGoLive() {
    fireEvent.click(await screen.findByRole('button', { name: 'Go live' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go live?' }));
  }

  it('opens the sound pipe first, then starts the stream with it, and shows the level meters while live', async () => {
    setup({ screen: 1, fps: 30, height: 720, kbps: 4500, desktopVolume: 0.8 });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Go live' }) as HTMLButtonElement).disabled).toBe(false));
    await pressGoLive();
    expect(shellMock.send).toHaveBeenCalledWith({ type: 'streamaudio', on: true, desktop: true, mic: 'mic-1', desktopVolume: 0.8, micVolume: 1 });
    // Nothing starts until the pipe is ready.
    expect(calls.some((c) => c.route === '/api/stream/start')).toBe(false);
    await fromShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await waitFor(() => expect(calls.some((c) => c.route === '/api/stream/start')).toBe(true));
    expect(calls.find((c) => c.route === '/api/stream/start')!.body).toEqual({ audioPipe: PIPE, test: false, settings: { screen: 1, fps: 30, height: 720, kbps: 4500 } });

    act(() => setStreamStatus({ ...current, state: 'live', startedAt: Date.now() - 5000, stats: { fps: 30, kbps: 4400, dropped: 1, frames: 150, speed: 1 } }));
    expect(await screen.findByText(/● Live 0:0\d · 4\.4 Mbps · 1 dropped/)).toBeTruthy();
    await fromShell({ type: 'audiolevels', desktop: 0.5, mic: 0.04 });
    expect(screen.getByRole('meter', { name: 'Desktop volume level' }).getAttribute('aria-valuenow')).toBe('0.5');
    expect(screen.getByRole('meter', { name: 'Mic volume level' }).getAttribute('aria-valuenow')).toBe('0.04');
    // The settings can't be changed under a running stream, but the volumes can: the app hears it.
    expect((screen.getByLabelText('Screen') as HTMLSelectElement).disabled).toBe(true);
    shellMock.send.mockClear();
    fireEvent.change(screen.getByLabelText('Desktop volume'), { target: { value: '150' } });
    expect(shellMock.send).toHaveBeenCalledWith({ type: 'streamaudiovolume', desktopVolume: 1.5, micVolume: 1 });
  });

  it('shows what the app said when it could not get the sound, and never starts', async () => {
    setup();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Go live' }) as HTMLButtonElement).disabled).toBe(false));
    await pressGoLive();
    await fromShell({ type: 'streamaudio', state: 'error', error: 'That mic isn’t connected.' });
    expect(await screen.findByText('That mic isn’t connected.')).toBeTruthy();
    expect(calls.some((c) => c.route === '/api/stream/start')).toBe(false);
    expect(screen.getByRole('button', { name: 'Go live' })).toBeTruthy();
  });

  it('ends the stream and then the sound with two clicks on End stream', async () => {
    setup();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Go live' }) as HTMLButtonElement).disabled).toBe(false));
    await pressGoLive();
    await fromShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await waitFor(() => expect(calls.some((c) => c.route === '/api/stream/start')).toBe(true));
    act(() => setStreamStatus({ ...current, state: 'live', startedAt: Date.now() }));
    fireEvent.click(await screen.findByRole('button', { name: 'End stream' }));
    expect(calls.some((c) => c.route === '/api/stream/stop')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'End stream?' }));
    await waitFor(() => expect(shellMock.send).toHaveBeenLastCalledWith({ type: 'streamaudio', on: false }));
    expect(calls.some((c) => c.route === '/api/stream/stop')).toBe(true);
    await screen.findByRole('button', { name: 'Go live' });
  });

  it('ends the stream when the app says the sound failed', async () => {
    setup();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Go live' }) as HTMLButtonElement).disabled).toBe(false));
    await pressGoLive();
    await fromShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await waitFor(() => expect(calls.some((c) => c.route === '/api/stream/start')).toBe(true));
    act(() => setStreamStatus({ ...current, state: 'live', startedAt: Date.now() }));
    await fromShell({ type: 'streamaudio', state: 'error', error: 'The speakers went away.' });
    await waitFor(() => expect(calls.some((c) => c.route === '/api/stream/stop')).toBe(true));
    expect(await screen.findByText('The speakers went away.')).toBeTruthy();
  });

  it('starts a test stream with one click', async () => {
    setup();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Test stream (not public)' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Test stream (not public)' }));
    await fromShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await waitFor(() => expect(calls.find((c) => c.route === '/api/stream/start')?.body).toMatchObject({ test: true }));
  });
});
