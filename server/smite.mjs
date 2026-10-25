// SMITE 2, live from the game's own log (%LOCALAPPDATA%\SMITE2Alpha\Saved\Logs\Hemingway.log; the
// game's codename is Hemingway). The log has the draft (each god as it's locked in, and for which
// team), the gods' abilities you cast (so: your god), every item you buy by name, and the map
// loads that mark the lobby, the draft and the match. Kills and damage aren't in it; those are on
// screen only.
//
//   GET /api/smite   the snapshot below, also pushed as a "smite" event when it changes

import { open, stat } from 'node:fs/promises';
import path from 'node:path';

const LOG = () => path.join(process.env.LOCALAPPDATA ?? '', 'SMITE2Alpha', 'Saved', 'Logs', 'Hemingway.log');
const POLL_MS = 1000;
const CONSUMABLE = /potion|ward|elixir|chalice|tonic/i;

/** A fresh snapshot: nothing seen yet. */
export function emptySmite() {
  return {
    /** 'lobby' between matches, 'draft' picking gods, 'match' playing. */
    phase: 'lobby',
    /** The mode, from the match map's folder: "Conquest", "Arena", "Joust"… */
    mode: '',
    startedAt: 0,
    endedAt: 0,
    god: '',
    allies: [],
    enemies: [],
    /** Items bought this match, in order, each once; potions and wards are counted apart. */
    build: [],
    consumables: {},
  };
}

/** "2026.10.16-21.23.32:630" (UTC) → ms. */
function timeOf(line) {
  const m = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/.exec(line);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0;
}

const squash = (name) => name.replace(/[^a-z]/gi, '').toLowerCase();
/** "MorganLeFay" → "Morgan Le Fay", for a god only seen by its ability names. */
const spaced = (name) => name.replace(/([a-z])([A-Z])/g, '$1 $2');

/**
 * The snapshot after one more log line. Returns the same object when the line changes nothing,
 * so callers can tell. Exported for tests.
 */
export function applyLine(s, line) {
  if (line.includes('LoadMap: ') && line.includes('/Lobbies/MatchLobby/')) {
    return { ...emptySmite(), phase: 'draft' };
  }
  if (line.includes('LoadMap: ') && line.includes('/Lobbies/MainLobby/')) {
    return s.phase === 'match' ? { ...s, phase: 'lobby', endedAt: timeOf(line) } : s.phase === 'lobby' ? s : { ...s, phase: 'lobby' };
  }
  let m = /SeamlessTravel to: \/Game\/Maps\/([^/]+)\//.exec(line);
  if (m) return { ...s, phase: 'match', mode: spaced(m[1]), startedAt: timeOf(line), endedAt: 0 };

  m = /LogHWBanPickDraft: (?:Warning: )?(.+?) locked\. Local Team: (\d+), Task Team: (\d+)/.exec(line);
  if (m) {
    const [, god, local, team] = m;
    const side = local === team ? 'allies' : 'enemies';
    if (s[side].includes(god)) return s;
    return { ...s, [side]: [...s[side], god] };
  }

  m = /LogHWAbilityInput: .*Default__GA_([A-Za-z]+)_A0\d/.exec(line);
  if (m && s.phase !== 'lobby') {
    // The draft name when there is one ("Morgan Le Fay"), else the ability's ("MorganLeFay").
    const god = s.allies.find((g) => squash(g) === squash(m[1])) ?? spaced(m[1]);
    return god === s.god ? s : { ...s, god };
  }

  m = /PurchaseItem - EquipmentToCraft->DevName: (.+?)\s{2,}EquipmentItem->DevName/.exec(line);
  if (m) {
    const raw = m[1].trim();
    const item = raw.includes(' ') ? raw : spaced(raw);
    if (CONSUMABLE.test(item)) return { ...s, consumables: { ...s.consumables, [item]: (s.consumables[item] ?? 0) + 1 } };
    return s.build.includes(item) ? s : { ...s, build: [...s.build, item] };
  }
  return s;
}

export function createSmite({ broadcastEvent, sendJson }) {
  let snap = emptySmite();
  let offset = 0;
  let rest = '';
  let polling = null;

  async function poll() {
    const file = LOG();
    const info = await stat(file).catch(() => null);
    if (!info) return;
    // A smaller file is a new one: the game restarted and started its log over.
    if (info.size < offset) {
      offset = 0;
      rest = '';
      snap = emptySmite();
    }
    if (info.size === offset) return;
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(info.size - offset);
      await fh.read(buf, 0, buf.length, offset);
      offset = info.size;
      const lines = (rest + buf.toString('utf8')).split(/\r?\n/);
      rest = lines.pop() ?? '';
      const before = snap;
      for (const line of lines) snap = applyLine(snap, line);
      if (snap !== before) broadcastEvent('smite', snap);
    } finally {
      await fh.close();
    }
  }

  // This one deliberately has no idle shutdown. The page asks for it once, when the SMITE preset
  // opens, and then only listens for events, and the log is the only record of the draft and the
  // build: a tail that paused would lose what happens while it is off. It costs one stat() a
  // second (and a read when the log grows), only after the SMITE preset was first opened.
  async function handle(req, res) {
    if (!polling) {
      // The whole current log first, so a match already under way shows up right away.
      await poll().catch(() => {});
      polling ??= setInterval(() => void poll().catch(() => {}), POLL_MS);
    }
    return sendJson(res, 200, snap);
  }

  /** Stops the tail (the server is shutting down). */
  handle.close = () => {
    clearInterval(polling);
    polling = null;
  };
  return handle;
}
