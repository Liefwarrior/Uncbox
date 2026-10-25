import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actionRequest,
  applyRecordStatus,
  applyStats,
  applyStreamStatus,
  authString,
  backoffDelay,
  bitrateKbps,
  createObsClient,
  emptySnapshot,
  isAudioKind,
  mergeSettings,
  reduceEvent,
  resyncFor,
  sceneNames,
} from './obs.mjs';

/** A stand-in for the WebSocket class: records what was sent and lets a test play OBS. */
class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closedWith = undefined;
    this.listeners = {};
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code) {
    this.closedWith = code;
    this.serverClose(code);
  }
  // The test side: what OBS would do.
  receive(op, d) {
    this.listeners.message?.forEach((f) => f({ data: JSON.stringify({ op, d }) }));
  }
  serverClose(code) {
    this.listeners.close?.forEach((f) => f({ code }));
  }
  requests() {
    return this.sent.filter((m) => m.op === 6).map((m) => m.d);
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('auth string', () => {
  it('matches the example in the obs-websocket protocol docs', () => {
    expect(authString('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=')).toBe(
      '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=',
    );
  });
});

describe('backoff', () => {
  it('doubles from two seconds and stops at thirty', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe('bitrate', () => {
  it('turns byte deltas into kilobits per second', () => {
    expect(bitrateKbps({ bytes: 1_000_000, at: 10_000 }, { bytes: 1_625_000, at: 11_000 })).toBe(5000);
    // Over a longer gap it averages.
    expect(bitrateKbps({ bytes: 0, at: 0 }, { bytes: 1_250_000, at: 2000 })).toBe(5000);
  });

  it('gives nothing when there is nothing to compare', () => {
    expect(bitrateKbps(null, { bytes: 5, at: 1 })).toBeNull();
    expect(bitrateKbps({ bytes: 100, at: 1000 }, { bytes: 50, at: 2000 })).toBeNull();
    expect(bitrateKbps({ bytes: 1, at: 1000 }, { bytes: 9, at: 1000 })).toBeNull();
  });
});

describe('snapshot reduction', () => {
  it('follows the stream and recording', () => {
    let s = emptySnapshot();
    s = reduceEvent(s, 'StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
    expect(s.stream.active).toBe(true);
    s = reduceEvent(s, 'StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING' });
    expect(s.stream).toMatchObject({ active: true, reconnecting: true });
    s = reduceEvent(s, 'StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTED' });
    expect(s.stream).toMatchObject({ active: true, reconnecting: false });
    s = reduceEvent(s, 'StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    expect(s.stream).toEqual(emptySnapshot().stream);

    s = reduceEvent(s, 'RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
    s = reduceEvent(s, 'RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED' });
    expect(s.record).toMatchObject({ active: true, paused: true });
    s = reduceEvent(s, 'RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_RESUMED' });
    expect(s.record.paused).toBe(false);
    s = reduceEvent(s, 'RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    expect(s.record).toEqual(emptySnapshot().record);
  });

  it('follows scenes, inputs and the other outputs', () => {
    let s = { ...emptySnapshot(), inputs: [{ name: 'Mic', muted: false }, { name: 'Desktop', muted: false }] };
    s = reduceEvent(s, 'CurrentProgramSceneChanged', { sceneName: 'Game' });
    expect(s.scene).toBe('Game');
    s = reduceEvent(s, 'SceneListChanged', { scenes: [{ sceneName: 'Be right back', sceneIndex: 0 }, { sceneName: 'Game', sceneIndex: 1 }] });
    expect(s.scenes).toEqual(['Game', 'Be right back']);
    s = reduceEvent(s, 'InputMuteStateChanged', { inputName: 'Mic', inputMuted: true });
    expect(s.inputs).toEqual([{ name: 'Mic', muted: true }, { name: 'Desktop', muted: false }]);
    s = reduceEvent(s, 'StudioModeStateChanged', { studioModeEnabled: true });
    s = reduceEvent(s, 'VirtualcamStateChanged', { outputActive: true });
    s = reduceEvent(s, 'ReplayBufferStateChanged', { outputActive: true });
    s = reduceEvent(s, 'ReplayBufferSaved', { savedReplayPath: 'C:\\secret\\clip.mp4' }, 1234);
    expect(s).toMatchObject({ studioMode: true, virtualCam: true, replayBuffer: true, replaySavedAt: 1234 });
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('ignores events it does not show, and says which ones need a re-read', () => {
    const s = emptySnapshot();
    expect(reduceEvent(s, 'InputVolumeMeters', {})).toBe(s);
    expect(resyncFor('SceneCreated')).toBe('scenes');
    expect(resyncFor('InputRemoved')).toBe('inputs');
    expect(resyncFor('CurrentSceneCollectionChanged')).toBe('all');
    expect(resyncFor('StreamStateChanged')).toBeNull();
  });

  it('reads the status answers', () => {
    const s = emptySnapshot();
    expect(applyStats(s, { cpuUsage: 3.456, activeFps: 59.94, renderSkippedFrames: 1, renderTotalFrames: 100, outputSkippedFrames: 2, outputTotalFrames: 90 }).stats).toEqual({
      cpu: 3.5,
      fps: 59.9,
      renderSkipped: 1,
      renderTotal: 100,
      outputSkipped: 2,
      outputTotal: 90,
    });
    const live = applyStreamStatus(s, { outputActive: true, outputReconnecting: false, outputTimecode: '00:01:02.345', outputCongestion: 0.1234, outputSkippedFrames: 4, outputTotalFrames: 400 }, 6000);
    expect(live.stream).toEqual({ active: true, reconnecting: false, timecode: '00:01:02', bitrate: 6000, congestion: 0.12, dropped: 4, total: 400 });
    expect(applyStreamStatus(live, { outputActive: false }, null).stream.active).toBe(false);
    expect(applyRecordStatus(s, { outputActive: true, outputPaused: true, outputTimecode: '00:00:09.000' }).record).toEqual({ active: true, paused: true, timecode: '00:00:09' });
  });

  it('puts scenes in the order OBS shows them and picks out the audio inputs', () => {
    expect(sceneNames([{ sceneName: 'a', sceneIndex: 0 }, { sceneName: 'c', sceneIndex: 2 }, { sceneName: 'b', sceneIndex: 1 }])).toEqual(['c', 'b', 'a']);
    expect(['wasapi_input_capture', 'wasapi_output_capture', 'coreaudio_input_capture', 'pulse_output_capture'].every(isAudioKind)).toBe(true);
    expect(['game_capture', 'browser_source', 'image_source'].some(isAudioKind)).toBe(false);
  });
});

describe('actions and settings', () => {
  it('maps page actions to OBS requests and refuses everything else', () => {
    expect(actionRequest({ type: 'SetCurrentProgramScene', sceneName: 'Game' })).toEqual({ requestType: 'SetCurrentProgramScene', requestData: { sceneName: 'Game' } });
    expect(actionRequest({ type: 'ToggleInputMute', inputName: 'Mic' }).requestData).toEqual({ inputName: 'Mic' });
    expect(actionRequest({ type: 'StartStream' })).toEqual({ requestType: 'StartStream', requestData: {} });
    expect(() => actionRequest({ type: 'SetCurrentProgramScene' })).toThrow('Missing scene name');
    expect(() => actionRequest({ type: 'RemoveScene', sceneName: 'x' })).toThrow('Unknown OBS action');
    expect(() => actionRequest({ type: 'constructor' })).toThrow('Unknown OBS action');
  });

  it('checks the host and port and keeps the password unless a new one comes', () => {
    const base = { host: '127.0.0.1', port: 4455, password: 'keep' };
    expect(mergeSettings(base, { host: ' pc.local ', port: '4466' })).toEqual({ host: 'pc.local', port: 4466, password: 'keep' });
    expect(mergeSettings(base, { password: '' }).password).toBe('');
    expect(mergeSettings(base, { host: '' }).host).toBe('127.0.0.1');
    expect(() => mergeSettings(base, { host: 'evil.com/path?x' })).toThrow('host name');
    expect(() => mergeSettings(base, { port: 70000 })).toThrow('port');
  });
});

describe('connection', () => {
  let snaps;
  let settings;
  let client;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    FakeWebSocket.instances = [];
    snaps = [];
    settings = { host: '127.0.0.1', port: 4455, password: '' };
    client = createObsClient({ WebSocketImpl: FakeWebSocket, getSettings: async () => settings, onSnapshot: (s) => snaps.push(s) });
  });
  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  /** Answers every request OBS gets with `answers[requestType]` (or a failure when there is none). */
  function answerAll(ws, answers) {
    const done = new Set();
    return async () => {
      for (const r of ws.requests()) {
        if (done.has(r.requestId)) continue;
        done.add(r.requestId);
        const data = answers[r.requestType];
        const result = typeof data === 'function' ? data(r.requestData) : data;
        ws.receive(7, {
          requestType: r.requestType,
          requestId: r.requestId,
          requestStatus: result ? { result: true, code: 100 } : { result: false, code: 600, comment: 'No such thing.' },
          responseData: result,
        });
      }
      await flush();
    };
  }

  const ANSWERS = {
    GetSceneList: { currentProgramSceneName: 'Game', scenes: [{ sceneName: 'Be right back', sceneIndex: 0 }, { sceneName: 'Game', sceneIndex: 1 }] },
    GetInputList: { inputs: [{ inputName: 'Mic/Aux', inputKind: 'wasapi_input_capture' }, { inputName: 'Desktop Audio', inputKind: 'wasapi_output_capture' }, { inputName: 'Capture', inputKind: 'game_capture' }] },
    GetSpecialInputs: { desktop1: 'Desktop Audio', mic1: 'Mic/Aux' },
    GetInputMute: (d) => ({ inputMuted: d.inputName === 'Mic/Aux' }),
    GetStats: { cpuUsage: 4, activeFps: 60, renderSkippedFrames: 0, renderTotalFrames: 10, outputSkippedFrames: 0, outputTotalFrames: 10 },
    GetStreamStatus: { outputActive: false },
    GetRecordStatus: { outputActive: false },
    GetStudioModeEnabled: { studioModeEnabled: false },
    GetVirtualCamStatus: { outputActive: false },
    GetReplayBufferStatus: { outputActive: true },
  };

  async function connected() {
    client.start();
    await flush();
    const ws = FakeWebSocket.instances.at(-1);
    return ws;
  }

  it('connects to the saved host and port, and says nothing more until OBS speaks', async () => {
    const ws = await connected();
    expect(ws.url).toBe('ws://127.0.0.1:4455');
    expect(ws.sent).toEqual([]);
  });

  it('identifies without a password when OBS does not ask for one, and loads the snapshot', async () => {
    const ws = await connected();
    ws.receive(0, { obsWebSocketVersion: '5.5.0', rpcVersion: 1 });
    await flush();
    expect(ws.sent[0]).toEqual({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 1 | 2 | 4 | 8 | 64 | 1024 } });
    ws.receive(2, { negotiatedRpcVersion: 1 });
    await flush();
    const answer = answerAll(ws, ANSWERS);
    await answer();
    await answer();
    await vi.advanceTimersByTimeAsync(1000);
    const s = client.snapshot();
    expect(s).toMatchObject({
      status: 'online',
      connected: true,
      scene: 'Game',
      scenes: ['Game', 'Be right back'],
      replayBuffer: true,
      stats: { cpu: 4, fps: 60 },
      inputs: [{ name: 'Desktop Audio', muted: false }, { name: 'Mic/Aux', muted: true }],
    });
    // Only audio kinds got a mute lookup.
    expect(ws.requests().filter((r) => r.requestType === 'GetInputMute').map((r) => r.requestData.inputName).sort()).toEqual(['Desktop Audio', 'Mic/Aux']);
  });

  it('proves the password when OBS asks for one', async () => {
    settings.password = 'supersecretpassword';
    const ws = await connected();
    ws.receive(0, { rpcVersion: 1, authentication: { salt: 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', challenge: '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=' } });
    await flush();
    expect(ws.sent[0].d.authentication).toBe('1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=');
  });

  it('reports a missing or wrong password as its own status', async () => {
    const ws = await connected();
    ws.receive(0, { rpcVersion: 1, authentication: { salt: 's', challenge: 'c' } });
    await flush();
    expect(ws.closedWith).toBe(1000);
    expect(client.snapshot().status).toBe('auth');

    settings.password = 'wrong';
    await vi.advanceTimersByTimeAsync(2000);
    const second = FakeWebSocket.instances.at(-1);
    expect(second).not.toBe(ws);
    second.receive(0, { rpcVersion: 1, authentication: { salt: 's', challenge: 'c' } });
    await flush();
    second.serverClose(4009);
    expect(client.snapshot().status).toBe('auth');
  });

  it('matches responses to requests by id, however they are ordered, and passes failures on', async () => {
    const ws = await connected();
    ws.receive(0, { rpcVersion: 1 });
    ws.receive(2, {});
    await flush();
    const first = client.request('StartStream');
    const second = client.request('SetCurrentProgramScene', { sceneName: 'Game' });
    const sent = ws.requests().slice(-2);
    expect(sent[1]).toMatchObject({ requestType: 'SetCurrentProgramScene', requestData: { sceneName: 'Game' } });
    expect(sent[0].requestId).not.toBe(sent[1].requestId);
    ws.receive(7, { requestType: 'SetCurrentProgramScene', requestId: sent[1].requestId, requestStatus: { result: false, code: 600, comment: 'No scene was found by the name of "Game".' } });
    ws.receive(7, { requestType: 'StartStream', requestId: sent[0].requestId, requestStatus: { result: true, code: 100 } });
    await expect(first).resolves.toEqual({});
    await expect(second).rejects.toMatchObject({ message: 'No scene was found by the name of "Game".', code: 600 });
  });

  it('gives up on a request OBS never answers, and fails waiting ones when the connection drops', async () => {
    const ws = await connected();
    ws.receive(0, { rpcVersion: 1 });
    ws.receive(2, {});
    await flush();
    const slow = client.request('GetVersion');
    const settled = expect(slow).rejects.toThrow('didn’t answer');
    await vi.advanceTimersByTimeAsync(5000);
    await settled;
    const waiting = client.request('GetVersion');
    const dropped = expect(waiting).rejects.toThrow('closed the connection');
    ws.serverClose(1006);
    await dropped;
    await expect(client.request('GetVersion')).rejects.toThrow('isn’t connected');
  });

  it('routes events into the snapshot and broadcasts at most once a second', async () => {
    const ws = await connected();
    ws.receive(0, { rpcVersion: 1 });
    ws.receive(2, {});
    await flush();
    snaps.length = 0;
    vi.advanceTimersByTime(1100);
    ws.receive(5, { eventType: 'CurrentProgramSceneChanged', eventIntent: 4, eventData: { sceneName: 'A' } });
    ws.receive(5, { eventType: 'CurrentProgramSceneChanged', eventIntent: 4, eventData: { sceneName: 'B' } });
    ws.receive(5, { eventType: 'StreamStateChanged', eventIntent: 64, eventData: { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' } });
    expect(client.snapshot().scene).toBe('B');
    // The first change went out at once; the rest wait for the second to pass.
    expect(snaps.map((s) => s.scene)).toEqual(['A']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(snaps.at(-1)).toMatchObject({ scene: 'B', stream: { active: true } });
    expect(snaps).toHaveLength(2);
  });

  it('works the stream bitrate out from the bytes OBS has sent between polls', async () => {
    const ws = await connected();
    ws.receive(0, { rpcVersion: 1 });
    ws.receive(2, {});
    await flush();
    ws.receive(5, { eventType: 'StreamStateChanged', eventData: { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' } });
    let bytes = 0;
    const answer = answerAll(ws, {
      ...ANSWERS,
      GetStreamStatus: () => ({ outputActive: true, outputTimecode: '00:00:05.000', outputBytes: (bytes += 750_000), outputSkippedFrames: 3, outputTotalFrames: 300, outputCongestion: 0 }),
    });
    await answer();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await answer();
    }
    expect(client.snapshot().stream).toMatchObject({ active: true, bitrate: 6000, dropped: 3, total: 300, timecode: '00:00:05' });
  });

  it('goes offline, and tries again after 2, 4, 8 … seconds without a new socket in between', async () => {
    const ws = await connected();
    ws.serverClose(1006);
    expect(client.snapshot()).toMatchObject({ status: 'offline', connected: false });
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].serverClose(1006);
    await vi.advanceTimersByTimeAsync(3999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Once OBS answers, the pause starts over.
    const third = FakeWebSocket.instances[2];
    third.receive(0, { rpcVersion: 1 });
    third.receive(2, {});
    await flush();
    third.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('reconnects at once, with the new settings', async () => {
    const ws = await connected();
    settings = { host: 'pc.local', port: 4466, password: '' };
    client.reconnect();
    await flush();
    expect(ws.closedWith).toBe(1000);
    expect(FakeWebSocket.instances.at(-1).url).toBe('ws://pc.local:4466');
    expect(FakeWebSocket.instances).toHaveLength(2);
    // The old socket closing does not start a second retry.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
