// Fakes for the browser and the Uncbox server that src/smoke.test.tsx renders the page against.
// Every endpoint the page calls has an "empty" answer (nothing set up, nothing running) and a
// "data" answer (everything connected and busy), so both the first-run and the lived-in screens
// get drawn.

export type Scenario = 'empty' | 'data';

export interface Reply {
  status?: number;
  body: unknown;
}

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 3_600_000;

const ping = (host: string) => ({ host, last: 23, avg: 25, jitter: 2, loss: 0, history: [20, 22, 25, null, 23, 24] });

const obsDown = {
  status: 'offline',
  connected: false,
  stream: { active: false, reconnecting: false, timecode: '00:00:00', bitrate: null, congestion: 0, dropped: 0, total: 0 },
  record: { active: false, paused: false, timecode: '00:00:00' },
  scene: '',
  scenes: [],
  stats: { cpu: 0, fps: 0, renderSkipped: 0, renderTotal: 0, outputSkipped: 0, outputTotal: 0 },
  inputs: [],
  studioMode: false,
  virtualCam: false,
  replayBuffer: false,
  replaySavedAt: 0,
};

const obsUp = {
  ...obsDown,
  status: 'online',
  connected: true,
  stream: { active: true, reconnecting: false, timecode: '01:02:03', bitrate: 6000, congestion: 0.1, dropped: 12, total: 9000 },
  record: { active: true, paused: false, timecode: '00:10:00' },
  scene: 'Game',
  scenes: ['Game', 'Chatting', 'Be right back'],
  stats: { cpu: 7.5, fps: 60, renderSkipped: 1, renderTotal: 900, outputSkipped: 0, outputTotal: 900 },
  inputs: [
    { name: 'Mic', muted: false },
    { name: 'Desktop audio', muted: true },
  ],
  replayBuffer: true,
};

const discordIdle = {
  status: 'unconfigured',
  error: '',
  fix: '',
  configured: false,
  builtIn: false,
  hasBuiltIn: false,
  clientId: '',
  user: null,
  channel: null,
  self: { mute: false, deaf: false },
  members: [],
};

const discordReady = {
  ...discordIdle,
  status: 'ready',
  configured: true,
  clientId: '1234',
  user: { id: '1', name: 'Eli' },
  channel: { id: '9', name: 'General', guildId: '2' },
  members: [
    { id: '1', name: 'Eli', avatar: '', mute: false, deaf: false, speaking: true },
    { id: '3', name: 'Sam', avatar: '', mute: true, deaf: false, speaking: false },
  ],
};

const googleOut = { configured: false, signedIn: false, email: '', scopes: [], needsConsent: false };
const googleIn = {
  configured: true,
  signedIn: true,
  email: 'eli@example.com',
  scopes: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.metadata',
  ],
  needsConsent: false,
};

const twitchOut = { configured: false, signedIn: false, signingIn: false, login: '', displayName: '', error: '' };
const twitchIn = { configured: true, signedIn: true, signingIn: false, login: 'eli', displayName: 'Eli', error: '' };
const stream = (live: boolean) => ({
  live,
  viewers: live ? 42 : 0,
  startedAt: live ? NOW - 3_725_000 : 0,
  title: live ? 'Late night ranked' : '',
  game: { id: '1', name: live ? 'SMITE 2' : '' },
  thumbnail: '',
  followers: 1234,
  subs: null,
  latestFollowers: live ? ['sam', 'alex'] : [],
  samples: live ? [10, 20, 35, 42] : [],
  updatedAt: NOW,
});

const steamIdle = { available: true, user: { name: 'Eli' }, playing: null, recent: [], commons: [] };
const steamBusy = {
  available: true,
  user: { name: 'Eli' },
  playing: {
    appid: 570,
    name: 'Dota 2',
    lastPlayed: NOW / 1000,
    playtime: 6000,
    since: NOW - HOUR,
    dir: '',
    achievements: { unlocked: 3, total: 10, latest: { name: 'First win', description: 'Win a match', icon: '', at: NOW } },
  },
  recent: [{ appid: 730, name: 'Counter-Strike 2', lastPlayed: NOW / 1000 - 86400, playtime: 120 }],
  commons: [],
};

const events = [
  { id: 'e1', calendar: 'Eli', color: '#3b82f6', title: 'Standup', start: iso(-HOUR / 4), end: iso(HOUR / 4), allDay: false, location: '', meetUrl: 'https://meet.google.com/abc', htmlLink: 'https://calendar.google.com/e1' },
  { id: 'e2', calendar: 'Eli', color: '#ef4444', title: 'Stream night', start: iso(HOUR * 5), end: iso(HOUR * 7), allDay: false, location: 'Home', meetUrl: '', htmlLink: '' },
  { id: 'e3', calendar: 'Eli', color: '#22c55e', title: 'Holiday', start: new Date(NOW).toISOString().slice(0, 10), end: new Date(NOW + 86_400_000).toISOString().slice(0, 10), allDay: true, location: '', meetUrl: '', htmlLink: '' },
];

const mail = {
  label: { id: 'INBOX', name: 'Inbox' },
  unread: 3,
  threadsUnread: 2,
  messages: [
    { id: 'm1', threadId: 't1', from: 'Sam', subject: 'Game tonight?', date: iso(-HOUR), unread: true, snippet: 'You in?', link: 'https://mail.google.com/m1' },
    { id: 'm2', threadId: 't2', from: 'Twitch', subject: 'You have a new follower', date: iso(-HOUR * 30), unread: false, link: 'https://mail.google.com/m2' },
  ],
};

const files = [
  { id: 'f1', name: 'Stream plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: iso(-HOUR), webViewLink: 'https://docs.google.com/f1', hasThumb: false, owner: 'Eli' },
  { id: 'f2', name: 'Thumbnail.png', mimeType: 'image/png', modifiedTime: iso(-HOUR * 50), webViewLink: 'https://drive.google.com/f2', hasThumb: true, owner: 'Sam' },
];

/** What the Uncbox server (and the one outside site the page asks) answers to a GET or POST. */
export function route(scenario: Scenario, path: string, method: string): Reply {
  const data = scenario === 'data';
  const url = new URL(path, 'http://localhost');
  const p = url.pathname;
  const ok = (body: unknown): Reply => ({ body });

  if (p.startsWith('https://') || path.startsWith('https://')) {
    // Open-Meteo: the geocoder and the forecast.
    if (path.includes('geocoding')) return ok({ results: data ? [{ name: 'Austin', admin1: 'Texas', country: 'United States', latitude: 30.27, longitude: -97.74 }] : [] });
    return ok({ current: { temperature_2m: 71.6, weather_code: 2, is_day: 1 }, daily: { temperature_2m_max: [80.1], temperature_2m_min: [60.4] } });
  }

  if (p === '/api/system') {
    return ok({ cpu: data ? 37 : 0, memory: { used: data ? 12e9 : 0, total: 32e9 }, gpu: data ? { name: 'RTX 4080', load: 55, temp: 61, used: 6e9, total: 16e9 } : null });
  }
  if (p === '/api/media') {
    return ok(
      data
        ? { playing: true, app: 'Spotify', title: 'Song', artist: 'Band', album: 'Album', art: '1', position: 30, age: 0.5, duration: 200, controls: { playPause: true, next: true, previous: true, seek: true } }
        : { playing: false },
    );
  }
  if (p === '/api/media/art') return { status: 404, body: { error: 'No art' } };
  if (p === '/api/notifications') {
    return ok({ notifications: data ? [{ id: 1, app: 'Discord', title: 'Sam', body: 'gg', at: NOW }] : [] });
  }
  if (p === '/api/netstats') {
    return ok({ key: 'k', targets: { k: ping('1.1.1.1') }, router: data ? ping('192.168.1.1') : null, game: data ? { name: 'Game', fps: 144, fpsLow: 120, fpsHistory: [140, 144, 150], gpuMs: 4.2, ping: 30, pingHistory: [30, 31] } : null });
  }
  if (p === '/api/obs') return ok(data ? obsUp : obsDown);
  if (p === '/api/obs/settings') return ok({ host: 'localhost', port: 4455, passwordSet: data });
  if (p === '/api/discord') return ok(data ? discordReady : discordIdle);
  if (p === '/api/discord/guilds') return ok(data ? [{ id: '2', name: 'Friends', icon: '' }] : []);
  if (p === '/api/discord/channels') return ok(data ? [{ id: '9', name: 'General' }] : []);
  if (p === '/api/steam') return ok(data ? steamBusy : steamIdle);
  if (p === '/api/steam/windowed') return ok({ on: data });
  if (p === '/api/smite') return ok(data ? { phase: 'match', mode: 'Conquest', startedAt: NOW, endedAt: 0, god: 'Zeus', allies: ['Ra'], enemies: ['Loki'], build: ['Boots'], consumables: {} } : { phase: 'lobby', mode: '', startedAt: 0, endedAt: 0, god: '', allies: [], enemies: [], build: [], consumables: {} });
  if (p === '/api/clips') {
    return ok({ dir: 'C:\\Videos\\Uncbox', hotkey: 'unsupported', clips: data ? [{ name: 'clip-1.mp4', size: 1e6, at: NOW }] : [] });
  }
  if (p === '/api/ytdlp') {
    const found = { found: true, path: 'C:\\Tools\\x.exe', version: '2026.07.04' };
    const gone = { found: false, path: '', version: '' };
    const item = { id: 'dl1', url: 'https://example.com/v', title: 'A video', percent: 40, speed: 2e6, eta: 30, height: 1080, fps: 60, vcodec: 'vp09.00.40.08', state: 'downloading', file: '', name: '', error: '', audioOnly: false };
    return ok({
      tools: { ytdlp: data ? found : gone, ffmpeg: data ? found : gone, winget: true, helpUrl: 'https://github.com/yt-dlp/yt-dlp/wiki/Installation' },
      install: { running: false, action: '', tool: '', lines: [], error: '' },
      queue: data ? [item] : [],
      history: data ? [{ ...item, id: 'dl0', state: 'done', percent: 100, file: 'A video [x].mp4', name: 'Downloads/A video [x].mp4' }] : [],
    });
  }
  if (p === '/api/clips/discord') return ok({ set: data, hint: data ? 'abcd' : '' });
  if (p === '/api/update') return ok({ update: data ? { version: '9.9.9', url: 'https://github.com/Liefwarrior/Uncbox/releases' } : null });
  if (p === '/api/gallery') {
    return data ? ok({ presets: [{ id: 'p1', name: 'Example', author: 'Sam', description: 'A preset', base: 'desk', widgets: [], file: 'p1.json', preview: 'p1.png' }], stale: false }) : { status: 503, body: { reason: 'offline', error: 'Offline' } };
  }
  if (p === '/api/running') return ok({ running: [] });
  if (p === '/api/web/frameable') return ok({ frameable: true });
  if (p === '/api/wow/status') return ok({ bundled: '1.0.0', installs: data ? [{ flavor: 'classic', path: 'C:\\WoW', installed: '1.0.0' }] : [] });
  if (p === '/api/google/status') return ok(data ? googleIn : googleOut);
  if (p === '/api/drive/local') return ok({ available: false, name: '' });
  if (p === '/api/drive/files') return data ? ok({ files, nextPageToken: '' }) : { status: 401, body: { code: 'signin', error: 'Sign in to Google.' } };
  if (p === '/api/calendar/events') return data ? ok({ events }) : { status: 401, body: { code: 'signin', error: 'Sign in to Google.' } };
  if (p === '/api/gmail/summary') return data ? ok(mail) : { status: 401, body: { code: 'signin', error: 'Sign in to Google.' } };
  if (p === '/api/gmail/labels') return data ? ok({ labels: [{ id: 'INBOX', name: 'Inbox', system: true }] }) : { status: 401, body: { code: 'signin', error: 'Sign in to Google.' } };
  if (p === '/api/twitch/status') return ok(data ? twitchIn : twitchOut);
  if (p === '/api/twitch/watch') return ok({ snapshot: data ? stream(true) : stream(false) });
  if (p === '/api/twitch/unwatch') return ok({ ok: true });
  if (p === '/api/launcher/tiles') {
    return ok({ tiles: data ? [{ id: 'l1', type: 'url', name: 'Wiki', target: 'https://example.com' }] : [] });
  }
  if (p === '/api/launcher/start-menu') return ok({ items: [] });
  if (p === '/api/ocr') return ok({ text: '' });
  // Writes (and anything not listed) are accepted and ignored.
  if (method !== 'GET') return ok({ ok: true });
  return { status: 404, body: { error: 'Not mocked' } };
}
