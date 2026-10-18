import { useEffect, useState } from 'react';

// Read-only Twitch chat over Twitch's IRC WebSocket. "justinfan" nicknames are Twitch's
// anonymous logins: no account, no token, can read any public channel and cannot send.

export type ChatPart = { kind: 'text'; text: string } | { kind: 'emote'; id: string; name: string };

export interface ChatMessage {
  id: string;
  login: string;
  name: string;
  color: string;
  parts: ChatPart[];
  /** /me messages render in the user's color. */
  action: boolean;
  /** Subs, raids, gift subs: Twitch's own announcement text. */
  system: boolean;
}

export type ChatStatus = 'idle' | 'connecting' | 'connected' | 'error';

const MAX_MESSAGES = 80;
const BOTS = new Set([
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'wizebot',
  'sery_bot',
  'soundalerts',
  'kofistreambot',
  'botrixoficial',
  'pokemoncommunitygame',
]);

export function isBot(login: string) {
  return BOTS.has(login);
}

export function emoteUrl(id: string) {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
}

export function normalizeChannel(raw: string) {
  const c = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//, '')
    .replace(/^#/, '')
    .split(/[/?]/)[0];
  return /^[a-z0-9_]{2,25}$/.test(c) ? c : '';
}

interface IrcLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

function unescapeTag(v: string) {
  return v.replace(/\\(.)/g, (_, c: string) => ({ s: ' ', ':': ';', r: '\r', n: '\n', '\\': '\\' })[c] ?? c);
}

export function parseLine(line: string): IrcLine {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const pair of rest.slice(1, sp).split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0) tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing: string | undefined;
  const t = rest.indexOf(' :');
  if (t >= 0) {
    trailing = rest.slice(t + 2);
    rest = rest.slice(0, t);
  }
  const [command = '', ...params] = rest.split(' ').filter(Boolean);
  if (trailing !== undefined) params.push(trailing);
  return { tags, prefix, command, params };
}

/** Splits text into text and emote runs. Twitch's emote ranges count code points, not UTF-16 units. */
export function splitEmotes(text: string, emotes: string | undefined): ChatPart[] {
  if (!emotes) return [{ kind: 'text', text }];
  const chars = Array.from(text);
  const ranges: { id: string; start: number; end: number }[] = [];
  for (const group of emotes.split('/')) {
    const [id, spans] = group.split(':');
    for (const span of spans?.split(',') ?? []) {
      const [start, end] = span.split('-').map(Number);
      if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ id, start, end });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const parts: ChatPart[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    if (r.start > cursor) parts.push({ kind: 'text', text: chars.slice(cursor, r.start).join('') });
    parts.push({ kind: 'emote', id: r.id, name: chars.slice(r.start, r.end + 1).join('') });
    cursor = r.end + 1;
  }
  if (cursor < chars.length) parts.push({ kind: 'text', text: chars.slice(cursor).join('') });
  return parts;
}

const FALLBACK_COLORS = ['#ff7b7b', '#7bc8ff', '#9be37b', '#ffc35c', '#d59bff', '#5ce0d0', '#ff9bd2', '#c8c8ff'];

/** Twitch lets users pick near-black name colors; lift those so they read on a dark panel. */
function readableColor(color: string, login: string) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) {
    let h = 0;
    for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  }
  const n = parseInt(m[1], 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.45) {
    const k = (0.45 - lum) / (1 - lum) + 0.15;
    [r, g, b] = [r, g, b].map((c) => Math.round(c + (255 - c) * k));
  }
  return `rgb(${r}, ${g}, ${b})`;
}

export function useTwitchChat(channel: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setMessages([]);
    setNotice('');
    if (!channel) {
      setStatus('idle');
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const push = (m: ChatMessage) => setMessages((list) => [...list.slice(-(MAX_MESSAGES - 1)), m]);

    const handle = (raw: string) => {
      if (!raw) return;
      if (raw.startsWith('PING')) {
        ws?.send(raw.replace('PING', 'PONG'));
        return;
      }
      const { tags, prefix, command, params } = parseLine(raw);
      switch (command) {
        case 'ROOMSTATE':
          attempt = 0;
          setStatus('connected');
          setNotice('');
          break;
        case 'PRIVMSG': {
          const login = prefix.split('!')[0];
          let text = params[1] ?? '';
          const action = text.startsWith('\u0001ACTION ') && text.endsWith('\u0001');
          if (action) text = text.slice(8, -1);
          push({
            id: tags.id || `${Date.now()}-${Math.random()}`,
            login,
            name: tags['display-name'] || login,
            color: readableColor(tags.color ?? '', login),
            parts: splitEmotes(text, tags.emotes),
            action,
            system: false,
          });
          break;
        }
        case 'USERNOTICE': {
          const login = tags.login ?? '';
          const sys = tags['system-msg'];
          if (sys) {
            push({
              id: `${tags.id || Date.now()}-sys`,
              login,
              name: '',
              color: '',
              parts: [{ kind: 'text', text: sys }],
              action: false,
              system: true,
            });
          }
          if (params[1]) {
            push({
              id: tags.id || `${Date.now()}`,
              login,
              name: tags['display-name'] || login,
              color: readableColor(tags.color ?? '', login),
              parts: splitEmotes(params[1], tags.emotes),
              action: false,
              system: false,
            });
          }
          break;
        }
        case 'CLEARCHAT': {
          // A ban or timeout names the user; a bare CLEARCHAT wipes the whole chat.
          const target = params[1];
          setMessages((list) => (target ? list.filter((m) => m.login !== target) : []));
          break;
        }
        case 'CLEARMSG': {
          const target = tags['target-msg-id'];
          setMessages((list) => list.filter((m) => m.id !== target));
          break;
        }
        case 'NOTICE':
          setNotice(params[1] ?? '');
          if (/suspended|does not exist|banned/i.test(params[1] ?? '')) setStatus('error');
          break;
        case 'RECONNECT':
          ws?.close();
          break;
      }
    };

    const connect = () => {
      setStatus('connecting');
      const sock = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      ws = sock;
      sock.onopen = () => {
        sock.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        sock.send('PASS SCHMOOPIIE');
        sock.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
        sock.send(`JOIN #${channel}`);
      };
      sock.onmessage = (e) => String(e.data).split('\r\n').forEach(handle);
      sock.onclose = () => {
        if (closed) return;
        setStatus('connecting');
        retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      };
      sock.onerror = () => sock.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, [channel]);

  return { messages, status, notice };
}
