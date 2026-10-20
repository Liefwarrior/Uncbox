// OBS, over obs-websocket v5 (built into OBS 28 and newer): stream health for the OBS widget and
// the buttons that control OBS. Nothing starts until the page first asks, so people who don't use
// the widget never have a socket open. The connection settings live in data/obs.json on this PC;
// the password is never sent to the page, which is only told whether one is set.
//
//   GET  /api/obs            the live snapshot, also pushed as an "obs" event (at most once a second)
//   GET  /api/obs/settings   { host, port, passwordSet }; this PC only
//   POST /api/obs/settings   { host, port, password? } saves them and reconnects; this PC only
//   POST /api/obs/action     { type, ... } switches scenes, starts and stops things; this PC only

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = { host: '127.0.0.1', port: 4455 };

/** How often OBS gets asked for stats while connected, and the most often the page hears about it. */
const POLL_MS = 1000;
const EMIT_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_AUDIO_INPUTS = 12;

/** obs-websocket event categories: General, Config, Scenes, Inputs, Outputs, plus Ui for studio mode. */
export const EVENT_SUBSCRIPTIONS = 1 | 2 | 4 | 8 | 64 | 1024;

// ---- protocol pieces ----

/** The password proof OBS asks for: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function authString(password, salt, challenge) {
  const secret = createHash('sha256').update(password + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}

/** How long to wait before the next try when OBS isn't there: 2 s, 4 s, 8 s … never over 30 s. */
export function backoffDelay(attempt) {
  return Math.min(30_000, 2000 * 2 ** Math.max(0, attempt));
}

/** Stream bitrate in kilobits per second from two byte counts, or null when they can't be compared. */
export function bitrateKbps(prev, cur) {
  if (!prev || !cur) return null;
  const seconds = (cur.at - prev.at) / 1000;
  if (seconds <= 0 || cur.bytes < prev.bytes) return null;
  return Math.round(((cur.bytes - prev.bytes) * 8) / seconds / 1000);
}

/** "00:12:34.567" → "00:12:34". */
export function shortTime(timecode) {
  return typeof timecode === 'string' ? timecode.slice(0, 8) : '';
}

/** OBS lists scenes bottom to top; people read them top to bottom. */
export function sceneNames(scenes) {
  if (!Array.isArray(scenes)) return [];
  return [...scenes].sort((a, b) => (b.sceneIndex ?? 0) - (a.sceneIndex ?? 0)).map((s) => String(s.sceneName));
}

/** Mics and desktop audio (and the like) are the input kinds worth a mute button. */
export function isAudioKind(kind) {
  return /wasapi|coreaudio|pulse|alsa|jack|sndio|audio/i.test(String(kind));
}

// ---- the snapshot ----

export function emptySnapshot(status = 'offline') {
  return {
    status,
    connected: false,
    stream: { active: false, reconnecting: false, timecode: '', bitrate: null, congestion: 0, dropped: 0, total: 0 },
    record: { active: false, paused: false, timecode: '' },
    scene: '',
    scenes: [],
    stats: { cpu: 0, fps: 0, renderSkipped: 0, renderTotal: 0, outputSkipped: 0, outputTotal: 0 },
    inputs: [],
    studioMode: false,
    virtualCam: false,
    replayBuffer: false,
    replaySavedAt: 0,
  };
}

/** Which part of the snapshot an event means has to be read again from OBS, or null. */
export function resyncFor(type) {
  if (type === 'CurrentSceneCollectionChanged') return 'all';
  if (['SceneCreated', 'SceneRemoved', 'SceneNameChanged'].includes(type)) return 'scenes';
  if (['InputCreated', 'InputRemoved', 'InputNameChanged'].includes(type)) return 'inputs';
  return null;
}

/** The snapshot after one OBS event. Events that change nothing we show give the same snapshot back. */
export function reduceEvent(snap, type, data = {}, now = Date.now()) {
  switch (type) {
    case 'StreamStateChanged': {
      // While OBS is reconnecting to the server the stream is still on, just not getting through.
      if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_RECONNECTING') return { ...snap, stream: { ...snap.stream, active: true, reconnecting: true } };
      if (!data.outputActive) return { ...snap, stream: emptySnapshot().stream };
      return { ...snap, stream: { ...snap.stream, active: true, reconnecting: false } };
    }
    case 'RecordStateChanged': {
      const state = data.outputState;
      if (!data.outputActive) return { ...snap, record: emptySnapshot().record };
      const paused = state === 'OBS_WEBSOCKET_OUTPUT_PAUSED' ? true : state === 'OBS_WEBSOCKET_OUTPUT_RESUMED' ? false : snap.record.paused;
      return { ...snap, record: { ...snap.record, active: true, paused } };
    }
    case 'ReplayBufferStateChanged':
      return { ...snap, replayBuffer: Boolean(data.outputActive) };
    case 'ReplayBufferSaved':
      return { ...snap, replaySavedAt: now };
    case 'VirtualcamStateChanged':
      return { ...snap, virtualCam: Boolean(data.outputActive) };
    case 'CurrentProgramSceneChanged':
      return { ...snap, scene: String(data.sceneName ?? '') };
    case 'SceneListChanged':
      return { ...snap, scenes: sceneNames(data.scenes) };
    case 'InputMuteStateChanged':
      return { ...snap, inputs: snap.inputs.map((i) => (i.name === data.inputName ? { ...i, muted: Boolean(data.inputMuted) } : i)) };
    case 'StudioModeStateChanged':
      return { ...snap, studioMode: Boolean(data.studioModeEnabled) };
    default:
      return snap;
  }
}

/** GetStats: CPU, frame rate and skipped frames. */
export function applyStats(snap, r) {
  return {
    ...snap,
    stats: {
      cpu: Math.round((r.cpuUsage ?? 0) * 10) / 10,
      fps: Math.round((r.activeFps ?? 0) * 10) / 10,
      renderSkipped: r.renderSkippedFrames ?? 0,
      renderTotal: r.renderTotalFrames ?? 0,
      outputSkipped: r.outputSkippedFrames ?? 0,
      outputTotal: r.outputTotalFrames ?? 0,
    },
  };
}

/** GetStreamStatus, with the bitrate worked out from the byte counts. */
export function applyStreamStatus(snap, r, bitrate) {
  if (!r.outputActive) return { ...snap, stream: emptySnapshot().stream };
  return {
    ...snap,
    stream: {
      active: true,
      reconnecting: Boolean(r.outputReconnecting),
      timecode: shortTime(r.outputTimecode),
      bitrate,
      congestion: Math.round((r.outputCongestion ?? 0) * 100) / 100,
      dropped: r.outputSkippedFrames ?? 0,
      total: r.outputTotalFrames ?? 0,
    },
  };
}

/** GetRecordStatus. */
export function applyRecordStatus(snap, r) {
  if (!r.outputActive) return { ...snap, record: emptySnapshot().record };
  return { ...snap, record: { active: true, paused: Boolean(r.outputPaused), timecode: shortTime(r.outputTimecode) } };
}

// ---- controls ----

const NO_DATA = () => ({});
const ACTIONS = {
  SetCurrentProgramScene: (b) => ({ sceneName: text(b.sceneName, 'scene') }),
  StartStream: NO_DATA,
  StopStream: NO_DATA,
  StartRecord: NO_DATA,
  StopRecord: NO_DATA,
  PauseRecord: NO_DATA,
  ResumeRecord: NO_DATA,
  ToggleInputMute: (b) => ({ inputName: text(b.inputName, 'input') }),
  StartReplayBuffer: NO_DATA,
  StopReplayBuffer: NO_DATA,
  SaveReplayBuffer: NO_DATA,
  StartVirtualCam: NO_DATA,
  StopVirtualCam: NO_DATA,
};

function text(value, what) {
  if (typeof value !== 'string' || !value || value.length > 256) throw badRequest(`Missing ${what} name.`);
  return value;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** The OBS request for a page action ({ type: 'StartStream' } …), or a 400 for anything else. */
export function actionRequest(body) {
  const build = typeof body?.type === 'string' && Object.hasOwn(ACTIONS, body.type) ? ACTIONS[body.type] : null;
  if (!build) throw badRequest('Unknown OBS action.');
  return { requestType: body.type, requestData: build(body) };
}

// ---- settings ----

const HOST = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:.]+)$/;

/** The settings after the page's changes: host and port checked, password kept unless a new one came. */
export function mergeSettings(current, input) {
  const next = { ...current };
  if (input?.host !== undefined) {
    const host = String(input.host).trim();
    if (host && (host.length > 253 || !HOST.test(host))) throw badRequest('That doesn’t look like a host name or address.');
    next.host = host || DEFAULT_SETTINGS.host;
  }
  if (input?.port !== undefined && input.port !== '') {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('The port is a number from 1 to 65535.');
    next.port = port;
  } else if (input?.port === '') next.port = DEFAULT_SETTINGS.port;
  if (typeof input?.password === 'string') {
    if (input.password.length > 256) throw badRequest('That password is too long.');
    next.password = input.password;
  }
  return next;
}

/** Where the settings are kept: one small JSON file in the data folder. */
export function createSettingsStore(dataDir) {
  const file = path.join(dataDir, 'obs.json');
  return {
    async get() {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        return mergeSettings({ ...DEFAULT_SETTINGS, password: '' }, saved);
      } catch {
        return { ...DEFAULT_SETTINGS, password: '' };
      }
    },
    async set(settings) {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(settings), { mode: 0o600 });
      await rename(tmp, file);
    },
  };
}

// ---- the connection ----

/**
 * One connection to OBS that keeps itself up: it tries again with a growing pause while OBS isn't
 * running, asks for stats every second and folds OBS's events into a snapshot. `WebSocketImpl`,
 * `getSettings` and `onSnapshot` are what the tests swap out.
 */
export function createObsClient({ WebSocketImpl = globalThis.WebSocket, getSettings, onSnapshot, onConnect = () => {}, now = () => Date.now() }) {
  let snap = emptySnapshot();
  let ws = null;
  let identified = false;
  let started = false;
  let authFailed = false;
  let attempts = 0;
  let retryTimer = null;
  let pollTimer = null;
  let polling = false;
  let nextId = 1;
  const pending = new Map();
  let streamBytes = null;

  let lastEmitAt = 0;
  let emitTimer = null;
  let lastJson = '';

  /** Tells the listener, but never more than once a second and never when nothing changed. */
  function emit(final = false) {
    const t = now();
    if (!final && t - lastEmitAt < EMIT_MS) {
      emitTimer ??= setTimeout(() => {
        emitTimer = null;
        emit(true);
      }, EMIT_MS - (t - lastEmitAt));
      return;
    }
    lastEmitAt = t;
    const json = JSON.stringify(snap);
    if (json === lastJson) return;
    lastJson = json;
    onSnapshot(snap);
  }

  function update(next) {
    if (next !== snap) {
      snap = next;
      emit();
    }
  }

  function send(op, d) {
    ws?.send(JSON.stringify({ op, d }));
  }

  /** Asks OBS something and settles with its answer (responseData) or its reason for saying no. */
  function request(requestType, requestData) {
    if (!ws || !identified) return Promise.reject(Object.assign(new Error('OBS isn’t connected.'), { code: 0 }));
    const requestId = `r${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Object.assign(new Error('OBS didn’t answer.'), { code: 0 }));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      send(6, { requestType, requestId, ...(requestData ? { requestData } : {}) });
    });
  }

  function failPending(reason) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(reason), { code: 0 }));
    }
    pending.clear();
  }

  async function loadScenes() {
    const r = await request('GetSceneList');
    update({ ...snap, scene: String(r.currentProgramSceneName ?? ''), scenes: sceneNames(r.scenes) });
  }

  async function loadInputs() {
    const [list, special] = await Promise.all([request('GetInputList'), request('GetSpecialInputs').catch(() => ({}))]);
    const specials = ['desktop1', 'desktop2', 'mic1', 'mic2', 'mic3', 'mic4'].map((k) => special[k]).filter(Boolean);
    const names = [...new Set([...specials, ...list.inputs.filter((i) => isAudioKind(i.inputKind)).map((i) => i.inputName)])].slice(0, MAX_AUDIO_INPUTS);
    const mutes = await Promise.all(names.map((name) => request('GetInputMute', { inputName: name }).catch(() => null)));
    const inputs = names.flatMap((name, i) => (mutes[i] ? [{ name, muted: Boolean(mutes[i].inputMuted) }] : []));
    update({ ...snap, inputs });
  }

  /** Reads the lot from OBS once, right after connecting. Anything OBS can't answer is left out. */
  async function sync() {
    const one = async (type, apply) => {
      try {
        apply(await request(type));
      } catch {
        // Not every OBS has every output (no replay buffer, say); the rest still shows.
      }
    };
    await Promise.all([
      loadScenes().catch(() => {}),
      loadInputs().catch(() => {}),
      one('GetStats', (r) => update(applyStats(snap, r))),
      one('GetStreamStatus', (r) => update(applyStreamStatus(snap, r, null))),
      one('GetRecordStatus', (r) => update(applyRecordStatus(snap, r))),
      one('GetStudioModeEnabled', (r) => update({ ...snap, studioMode: Boolean(r.studioModeEnabled) })),
      one('GetVirtualCamStatus', (r) => update({ ...snap, virtualCam: Boolean(r.outputActive) })),
      one('GetReplayBufferStatus', (r) => update({ ...snap, replayBuffer: Boolean(r.outputActive) })),
    ]);
  }

  /** Once a second: the numbers that have no event. The stream and recording ones only while they run. */
  async function poll() {
    if (polling || !identified) return;
    polling = true;
    try {
      const [stats, stream, record] = await Promise.allSettled([
        request('GetStats'),
        snap.stream.active ? request('GetStreamStatus') : null,
        snap.record.active ? request('GetRecordStatus') : null,
      ]);
      if (!identified) return;
      let next = snap;
      if (stats.status === 'fulfilled') next = applyStats(next, stats.value);
      if (stream.status === 'fulfilled' && stream.value) {
        const sample = { bytes: stream.value.outputBytes ?? 0, at: now() };
        const kbps = stream.value.outputActive ? bitrateKbps(streamBytes, sample) : null;
        streamBytes = stream.value.outputActive ? sample : null;
        next = applyStreamStatus(next, stream.value, kbps ?? (next.stream.active ? next.stream.bitrate : null));
      } else if (!snap.stream.active) streamBytes = null;
      if (record.status === 'fulfilled' && record.value) next = applyRecordStatus(next, record.value);
      update(next);
    } finally {
      polling = false;
    }
  }

  function handleEvent(type, data) {
    // A new stream starts counting bytes from zero again.
    if (type === 'StreamStateChanged' && !data?.outputActive) streamBytes = null;
    update(reduceEvent(snap, type, data, now()));
    const again = resyncFor(type);
    if (again === 'all') void sync();
    else if (again === 'scenes') void loadScenes().catch(() => {});
    else if (again === 'inputs') void loadInputs().catch(() => {});
  }

  async function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    const d = msg.d ?? {};
    if (msg.op === 0) {
      // Hello: say who we are, proving the password if OBS wants one.
      const identify = { rpcVersion: 1, eventSubscriptions: EVENT_SUBSCRIPTIONS };
      if (d.authentication) {
        const { password } = await getSettings();
        if (!password) {
          authFailed = true;
          ws?.close(1000);
          return;
        }
        identify.authentication = authString(password, d.authentication.salt, d.authentication.challenge);
      }
      send(1, identify);
    } else if (msg.op === 2) {
      identified = true;
      authFailed = false;
      attempts = 0;
      snap = { ...snap, status: 'online', connected: true };
      emit();
      onConnect();
      pollTimer = setInterval(() => void poll(), POLL_MS);
      void sync();
    } else if (msg.op === 5) {
      handleEvent(d.eventType, d.eventData);
    } else if (msg.op === 7) {
      const p = pending.get(d.requestId);
      if (!p) return;
      pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (d.requestStatus?.result) p.resolve(d.responseData ?? {});
      else p.reject(Object.assign(new Error(d.requestStatus?.comment || 'OBS said no.'), { code: d.requestStatus?.code ?? 0 }));
    }
  }

  function handleClose(socket, code) {
    if (socket !== ws) return;
    ws = null;
    identified = false;
    clearInterval(pollTimer);
    pollTimer = null;
    polling = false;
    streamBytes = null;
    failPending('OBS closed the connection.');
    // 4009 is OBS saying the password was wrong.
    const wrongPassword = authFailed || code === 4009;
    authFailed = wrongPassword;
    snap = emptySnapshot(wrongPassword ? 'auth' : 'offline');
    emit();
    schedule();
  }

  function schedule() {
    if (!started || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, backoffDelay(attempts++));
  }

  async function connect() {
    if (!started || ws) return;
    let settings;
    try {
      settings = await getSettings();
    } catch {
      return schedule();
    }
    if (!started || ws) return;
    const host = settings.host.includes(':') && !settings.host.startsWith('[') ? `[${settings.host}]` : settings.host;
    let socket;
    try {
      socket = new WebSocketImpl(`ws://${host}:${settings.port}`);
    } catch {
      return schedule();
    }
    ws = socket;
    socket.addEventListener('message', (e) => {
      if (socket === ws) void handleMessage(e.data);
    });
    // An error is always followed by a close, which is where it gets handled.
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', (e) => handleClose(socket, e?.code));
  }

  function drop() {
    const old = ws;
    ws = null;
    identified = false;
    clearInterval(pollTimer);
    pollTimer = null;
    polling = false;
    streamBytes = null;
    failPending('OBS closed the connection.');
    try {
      old?.close(1000);
    } catch {
      // Already gone.
    }
  }

  return {
    /** Starts connecting (once); safe to call again. */
    start() {
      if (started) return;
      started = true;
      void connect();
    },
    /** Connects again right away, e.g. after the settings changed. */
    reconnect() {
      if (!started) return;
      drop();
      clearTimeout(retryTimer);
      retryTimer = null;
      attempts = 0;
      authFailed = false;
      snap = emptySnapshot();
      emit();
      void connect();
    },
    stop() {
      started = false;
      clearTimeout(retryTimer);
      clearTimeout(emitTimer);
      retryTimer = emitTimer = null;
      drop();
    },
    request,
    snapshot: () => snap,
    // For the tests.
    get attempts() {
      return attempts;
    },
  };
}

// ---- wiring into the server ----

/** The route handler for /api/obs. */
export function createObs({ broadcastEvent, sendJson, isLocal, readJson, dataDir, WebSocketImpl }) {
  const store = createSettingsStore(dataDir);
  const client = createObsClient({
    WebSocketImpl,
    getSettings: () => store.get(),
    onSnapshot: (snap) => broadcastEvent('obs', snap),
  });

  const publicSettings = (s) => ({ host: s.host, port: s.port, passwordSet: Boolean(s.password) });

  return async function handle(req, res, url) {
    const route = url.pathname.slice('/api/obs'.length);
    try {
      if (route === '' && req.method === 'GET') {
        client.start();
        return sendJson(res, 200, client.snapshot());
      }
      if (route === '/settings') {
        if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC OBS is on.' });
        if (req.method === 'GET') return sendJson(res, 200, publicSettings(await store.get()));
        if (req.method === 'POST') {
          const next = mergeSettings(await store.get(), await readJson(req));
          await store.set(next);
          client.start();
          client.reconnect();
          return sendJson(res, 200, publicSettings(next));
        }
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      if (route === '/action' && req.method === 'POST') {
        if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC OBS is on.' });
        const { requestType, requestData } = actionRequest(await readJson(req));
        try {
          await client.request(requestType, Object.keys(requestData).length ? requestData : undefined);
        } catch (err) {
          return sendJson(res, err.code ? 409 : 503, { error: err.code ? err.message : 'OBS isn’t connected.' });
        }
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'OBS error' });
    }
  };
}
