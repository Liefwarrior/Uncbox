import { keyLabel } from '../clips/keys';
import type { ClipFile } from '../clips/replay';
import type { IconName } from '../components/Icon';
import { addWidgetTo, setPanelShown } from '../layout';
import type { ObsAction, ObsSnapshot } from '../obs';
import { PRESETS } from '../presets';
import { type AppState, PRESET_IDS, type Widget } from '../state/model';
import { activePreset } from '../state/presets';
import type { MutatePreset, Mutate } from '../state/useAppState';
import { resolveAddress, SEARCH_ENGINES, searchUrl } from '../web';
import { fileIcon, fileKind, type DriveFile } from '../widgets/drive/drive';
import { isAuctionHouseWidget } from '../widgets/auctionhouse/settings';
import { isFocusWidget, isRunning, remaining, settle, stateOf, configOf, toggleFocus } from '../widgets/focus/focus';
import { newWidget, panelTitle, WIDGETS, widgetTitle } from '../widgets/registry';
import { isSingle } from '../widgets/types';
import { fold } from '../widgets/shared/wowGuild';
import { isWebWidget } from '../widgets/web/settings';
import { TILE_KINDS, type Tile } from '../widgets/launcher/launcher';
import { fuzzyMatch, type Match } from './fuzzy';
import { MAX_RECENT } from './recent';

// The command palette's commands. Each part of Uncbox adds its own through a small provider: a
// function from what the app knows right now to the commands that make sense now. A command that
// can't run (OBS not connected, no clip to open) is left out rather than shown greyed. To add
// commands for a new widget, write a provider and add it to `providers`.

export interface Command {
  /** Stable between visits, so "recently used" can remember it. */
  id: string;
  title: string;
  /** The heading it is listed under. */
  group: string;
  icon?: IconName;
  /** A key that does the same thing, shown as a key cap. */
  shortcut?: string;
  /** A few plain words after the title. */
  detail?: string;
  /** More words that find it ("scene" for an OBS command). Matched less strongly than the title. */
  keywords?: string;
  /** False leaves it out. */
  enabled?: boolean;
  /**
   * Set for a command made from the typed text itself (a web address, a Drive result): the text
   * doesn't filter it, this is its score, and it isn't remembered as "recently used".
   */
  live?: number;
  run: () => void;
}

/** Everything the palette does to the app, so the commands can be built (and tested) without it. */
export interface PaletteActions {
  saveClip: () => void;
  watchClip: (name: string) => void;
  revealClips: () => void;
  launchTile: (tile: Tile) => void;
  openDriveFile: (file: DriveFile) => void;
  obs: (action: ObsAction) => void;
  /** Takes a Web widget on screen to a page. False if it isn't on screen. */
  openWeb: (widgetId: string, url: string) => boolean;
  /** Before a focus timer starts, so its chime is allowed to make a sound. */
  primeAudio: () => void;
  /** Points at a panel that was just added. */
  callOut: (id: Widget['id']) => void;
  toggleStream: () => void;
  /** Starts streaming from Uncbox (or, with true, a test stream that isn't public). */
  goLive: (test: boolean) => void;
  endStream: () => void;
  /** Opens the preset gallery. */
  browsePresets: () => void;
  /** Opens the sidebar's editor for a new automation. */
  addAutomation: () => void;
  /** Saves the video at a web address with yt-dlp. */
  downloadVideo: (url: string) => void;
  /** Asks a Guild roster widget to show a member (it does as soon as it is on screen). */
  showMember: (widgetId: Widget['id'], name: string) => void;
}

export interface PaletteContext {
  state: AppState;
  mutate: Mutate;
  mutatePreset: MutatePreset;
  /** What is typed in the palette. */
  query: string;
  clips: { recording: boolean; saving: boolean; clips: ClipFile[] };
  /** The saved launcher tiles, once the server has answered. */
  tiles: Tile[] | null;
  drive: { signedIn: boolean; results: DriveFile[] };
  /** On air: nothing personal (Drive file names) is listed. */
  private?: boolean;
  obs: ObsSnapshot | null;
  /** Streaming from Uncbox: whether it is going or starting, and whether it could start now (a key, FFmpeg and NVENC). */
  stream: { active: boolean; ready: boolean };
  /** The guild's member names, once known (only asked for on the WoW preset). */
  wow: { members: string[] } | null;
  actions: PaletteActions;
  now: number;
}

export type Provider = (ctx: PaletteContext) => Command[];

/** Headings in the order they are listed (before a search puts the best match's heading first). */
export const GROUPS = ['Presets', 'Panels', 'Widgets', 'Clips', 'Stream', 'Launcher', 'Web', 'Downloads', 'Drive', 'OBS', 'WoW', 'Focus timer', 'Auction House', 'Automations'] as const;

// ---- presets ----

const presetCommands: Provider = ({ state, mutate, actions }) => {
  const make = (id: string, name: string, detail?: string): Command => ({
    id: `preset:${id}`,
    title: `Switch to ${name}`,
    group: 'Presets',
    icon: 'gamepad',
    detail,
    keywords: 'preset game layout',
    enabled: state.preset !== id,
    run: () => mutate((s) => void (s.preset = id as AppState['preset'])),
  });
  const browse: Command = {
    id: 'preset:browse',
    title: 'Browse presets',
    group: 'Presets',
    icon: 'globe',
    detail: 'Install presets other people made',
    keywords: 'gallery community install download share',
    run: actions.browsePresets,
  };
  return [...PRESET_IDS.map((id) => make(id, PRESETS[id].name, PRESETS[id].blurb)), ...state.custom.map((c) => make(c.id, c.name, 'Your preset')), browse];
};

// ---- panels and widgets ----

// Show or hide each single panel (a kind there is only one of in a preset), and add the others
// from the widget library (src/widgets/registry.ts), in the order the library lists them.

const panelCommands: Provider = ({ state, mutatePreset }) => {
  const { base, def, data } = activePreset(state);
  const shown = new Set(data.layout.map((item) => item.i));
  const singles = WIDGETS.filter(isSingle);
  // The ones this preset recommends first, as in the library.
  const ordered = [...singles.filter((w) => w.presets?.includes(base)), ...singles.filter((w) => !w.presets?.includes(base))];
  return ordered.map((w): Command => {
    const on = shown.has(w.kind);
    return {
      id: `panel:${w.kind}`,
      title: `${on ? 'Hide' : 'Show'} ${panelTitle(def, w.kind)} panel`,
      group: 'Panels',
      icon: 'layout',
      detail: w.hint,
      keywords: `panel toggle on screen ${w.keywords ?? ''}`,
      run: () => mutatePreset((d) => setPanelShown(d, w.kind, !on)),
    };
  });
};

const widgetCommands: Provider = ({ state, mutatePreset, actions }) =>
  WIDGETS.filter((w) => !isSingle(w)).map((w): Command => ({
    id: `widget:add:${w.kind}`,
    title: `Add widget: ${w.name}`,
    group: 'Widgets',
    icon: w.icon,
    detail: w.hint,
    keywords: `new panel ${w.keywords ?? ''}`,
    run: () => {
      // A widget there is only one of is pointed at when it is already on the board.
      const there = w.onlyOne ? activePreset(state).data.widgets.find((x) => x.kind === w.kind) : undefined;
      if (there) return actions.callOut(there.id);
      const widget = newWidget(w.kind);
      mutatePreset((d) => addWidgetTo(d, widget));
      actions.callOut(widget.id);
    },
  }));

// ---- clips and stream mode ----

const clipCommands: Provider = ({ state, clips, actions }) => {
  const latest = clips.clips[0];
  return [
    {
      id: 'clip:save',
      title: 'Save a clip',
      group: 'Clips',
      icon: 'film',
      shortcut: state.clips.enabled ? keyLabel(state.clips.key) : undefined,
      detail: 'The last minute of your game',
      keywords: 'replay record',
      enabled: state.clips.enabled && clips.recording && !clips.saving,
      run: actions.saveClip,
    },
    {
      id: 'clip:latest',
      title: 'Open the latest clip',
      group: 'Clips',
      icon: 'play',
      keywords: 'watch replay',
      enabled: Boolean(latest),
      run: () => latest && actions.watchClip(latest.name),
    },
    { id: 'clip:folder', title: 'Open the clips folder', group: 'Clips', icon: 'folder', keywords: 'show reveal', run: actions.revealClips },
  ];
};

const streamCommands: Provider = ({ actions }) => [
  {
    id: 'stream:toggle',
    title: 'Toggle stream mode',
    group: 'Stream',
    icon: 'cast',
    shortcut: 'F8',
    detail: 'Full screen, edit controls hidden',
    keywords: 'fullscreen hide sidebar',
    run: actions.toggleStream,
  },
];

/** Streaming from Uncbox itself (not OBS): start, test and end. Starting is left out until a key and the tools are there. */
const goLiveCommands: Provider = ({ state, stream, actions }) => {
  if (state.stream.with !== 'uncbox') return [];
  if (stream.active) return [{ id: 'stream:end', title: 'End stream', group: 'Stream', icon: 'radio', detail: 'Stop streaming from Uncbox', keywords: 'stop live twitch broadcast', run: actions.endStream }];
  return [
    { id: 'stream:golive', title: 'Go live', group: 'Stream', icon: 'radio', detail: 'Stream your screen to Twitch', keywords: 'start twitch broadcast', enabled: stream.ready, run: () => actions.goLive(false) },
    { id: 'stream:test', title: 'Test stream (not public)', group: 'Stream', icon: 'radio', detail: 'Twitch takes it but shows it to no one', keywords: 'try go live twitch bandwidth', enabled: stream.ready, run: () => actions.goLive(true) },
  ];
};

// ---- launcher ----

const launcherCommands: Provider = ({ tiles, actions }) =>
  (tiles ?? []).map((tile): Command => ({
    id: `launch:${tile.id}`,
    title: `Launch ${tile.name}`,
    group: 'Launcher',
    icon: 'rocket',
    detail: TILE_KINDS.find((k) => k.type === tile.type)?.label,
    keywords: 'open start run',
    run: () => actions.launchTile(tile),
  }));

// ---- web ----

/** What the typed text means to the Web widget: a page to open, a search, or nothing (blocked or empty). */
export function classifyQuery(query: string, engineId = 'google'): { kind: 'url' | 'search' | 'none'; url: string } {
  const text = query.trim();
  const address = resolveAddress(text, engineId);
  if (address.kind === 'url') return { kind: 'url', url: address.url };
  if (address.kind === 'search') return { kind: 'search', url: address.url };
  return { kind: 'none', url: '' };
}

const short = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const webCommands: Provider = ({ state, query, mutatePreset, actions }) => {
  const text = query.trim();
  if (!text) return [];
  const { data } = activePreset(state);
  const widget = data.widgets.find(isWebWidget);
  const engineId = widget?.settings.searchEngine ?? 'google';
  const engine = SEARCH_ENGINES.find((e) => e.id === engineId) ?? SEARCH_ENGINES[0];
  const guess = classifyQuery(text, engineId);
  if (guess.kind === 'none') return [];

  /** The first Web widget goes there; with none, a new one opens on it. */
  const go = (url: string) => {
    if (widget) {
      if (!actions.openWeb(widget.id, url)) mutatePreset((d) => void (d.widgets.find((w) => w.id === widget.id)!.settings.url = url));
      return;
    }
    const w = newWidget('web');
    w.settings.url = url;
    mutatePreset((d) => addWidgetTo(d, w));
    actions.callOut(w.id);
  };
  const where = widget ? `in ${widgetTitle(widget)}` : 'in a new Web widget';
  const commands: Command[] = [];
  if (guess.kind === 'url') {
    commands.push({
      id: 'web:open',
      title: `Open ${short(text)} in a web widget`,
      group: 'Web',
      icon: 'globe',
      detail: where,
      live: 1000,
      run: () => go(guess.url),
    });
  }
  commands.push({
    id: 'web:search',
    title: `Search the web for ${short(text)}`,
    group: 'Web',
    icon: 'search',
    detail: `${engine.name}, ${where}`,
    // Below any command the words match, so Enter does what they say; for an address, Open is above.
    live: -100,
    run: () => go(searchUrl(text, engineId)),
  });
  return commands;
};

// ---- video downloads ----

/** A typed web address can also be downloaded as a video (yt-dlp, see widgets/downloads/downloads.ts). */
const downloadCommands: Provider = ({ query, actions }) => {
  const guess = classifyQuery(query);
  if (guess.kind !== 'url') return [];
  return [
    {
      id: 'download:url',
      title: `Download video: ${short(query.trim())}`,
      group: 'Downloads',
      icon: 'download',
      detail: 'Saved at the video’s own quality',
      live: 900,
      run: () => actions.downloadVideo(guess.url),
    },
  ];
};

// ---- drive ----

/** How many letters before Drive is searched. */
export const DRIVE_MIN_QUERY = 3;
export const DRIVE_SHOWN = 6;

const driveCommands: Provider = ({ query, drive, actions, private: hidden }) => {
  if (hidden || !drive.signedIn || query.trim().length < DRIVE_MIN_QUERY) return [];
  return drive.results.slice(0, DRIVE_SHOWN).map(
    (file, i): Command => ({
      id: `drive:${file.id}`,
      title: file.name,
      group: 'Drive',
      icon: fileIcon(file.mimeType),
      detail: fileKind(file.mimeType),
      live: -50 - i,
      run: () => actions.openDriveFile(file),
    }),
  );
};

// ---- OBS ----

const obsCommands: Provider = ({ obs, actions }) => {
  if (!obs?.connected) return [];
  const scenes = obs.scenes.map(
    (name): Command => ({
      id: `obs:scene:${name}`,
      title: `Switch OBS to ${name}`,
      group: 'OBS',
      icon: 'cast',
      detail: 'Scene',
      keywords: 'scene',
      enabled: name !== obs.scene,
      run: () => actions.obs({ type: 'SetCurrentProgramScene', sceneName: name }),
    }),
  );
  // Stopping the stream is left to the OBS widget, which asks first.
  const recording: Command = {
    id: 'obs:record',
    title: obs.record.active ? 'Stop recording' : 'Start recording',
    group: 'OBS',
    icon: 'video',
    keywords: 'obs record',
    run: () => actions.obs({ type: obs.record.active ? 'StopRecord' : 'StartRecord' }),
  };
  return [...scenes, recording];
};

// ---- WoW guild ----

/** How many guild members one search lists. */
export const WOW_MEMBERS_SHOWN = 5;

/** On the WoW preset: raid attendance, and a search for guild members that opens them in the Guild roster. */
const wowCommands: Provider = ({ state, query, wow, mutatePreset, actions }) => {
  const { base, data } = activePreset(state);
  if (base !== 'wow') return [];

  /** The first widget of a kind goes on screen (a new one if there is none); returns it. */
  const point = (kind: string): Widget => {
    const have = data.widgets.find((w) => w.kind === kind);
    if (have) return have;
    const widget = newWidget(kind);
    mutatePreset((d) => addWidgetTo(d, widget));
    return widget;
  };

  const commands: Command[] = [
    {
      id: 'wow:attendance',
      title: 'WoW: raid attendance',
      group: 'WoW',
      icon: 'calendar',
      detail: 'Who came to the last raids',
      keywords: 'raiders missed loot council dkp csv guild',
      run: () => actions.callOut(point('attendance').id),
    },
  ];

  // "kaz", "find member kaz" and "wow: find member kaz" all look for Kaz.
  const text = fold(query.trim().replace(/^(wow:?\s*)?(find member\s*)?/i, ''));
  if (wow && text.length >= 2) {
    wow.members
      .filter((name) => fold(name).includes(text))
      .slice(0, WOW_MEMBERS_SHOWN)
      .forEach((name, i) =>
        commands.push({
          id: `wow:member:${name}`,
          title: `WoW: find member ${name}`,
          group: 'WoW',
          icon: 'users',
          detail: 'Open them in the Guild roster',
          live: -30 - i,
          run: () => {
            const roster = point('guildroster');
            actions.showMember(roster.id, name);
            actions.callOut(roster.id);
          },
        }),
      );
  }
  return commands;
};

// ---- focus timer ----

const focusCommands: Provider = ({ state, mutatePreset, actions, now }) => {
  const { data } = activePreset(state);
  const timers = data.widgets.filter(isFocusWidget);
  return timers.map((w): Command => {
    const s = w.settings;
    const timer = settle(stateOf(s), now, configOf(s)).state;
    const running = isRunning(timer);
    const verb = running ? 'Pause' : timer.left ? 'Resume' : 'Start';
    const left = Math.ceil(remaining(timer, now, configOf(s)) / 60_000);
    return {
      id: `focus:toggle:${timers.length > 1 ? w.id : 'main'}`,
      title: `${verb} ${timers.length > 1 ? widgetTitle(w) : 'the focus timer'}`,
      group: 'Focus timer',
      icon: running ? 'pause' : 'play',
      detail: `${left} min left`,
      keywords: 'focus pomodoro break',
      run: () => {
        if (!running) actions.primeAudio();
        mutatePreset((d) => {
          const target = d.widgets.find((x) => x.id === w.id);
          if (target && isFocusWidget(target)) Object.assign(target.settings, toggleFocus(target.settings, Date.now()));
        });
      },
    };
  });
};

// ---- auction house ----

/** "AH: search" typed with a name after it ("ah: search linen", "ah linen"): the name, else null. */
export const ahSearchTerm = (query: string): string | null => {
  const m = /^\s*ah\b\s*:?\s*(?:search\b\s*:?\s*)?(.*)$/i.exec(query);
  return m && m[1].trim() ? m[1].trim() : null;
};

const ahCommands: Provider = ({ state, query, mutatePreset, actions }) => {
  const { base, data } = activePreset(state);
  const widget = data.widgets.find(isAuctionHouseWidget);
  /** Opens the Auction House widget on a tab (adding one if the board has none), with a search if there is one. */
  const open = (tab: 'search' | 'deals', search?: string) => {
    if (widget) {
      mutatePreset((d) => {
        const w = d.widgets.find((x) => x.id === widget.id);
        if (w) Object.assign(w.settings, { tab, ...(search !== undefined ? { query: search } : {}) });
      });
      actions.callOut(widget.id);
      return;
    }
    const w = newWidget('auctionhouse', { settings: { tab, ...(search !== undefined ? { query: search } : {}) } });
    mutatePreset((d) => addWidgetTo(d, w));
    actions.callOut(w.id);
  };
  const commands: Command[] = [
    { id: 'ah:deals', title: 'AH: deals', group: 'Auction House', icon: 'coins', detail: 'Listings worth buying', keywords: 'auction house flips bargains wow', run: () => open('deals') },
  ];
  const typed = ahSearchTerm(query);
  // "ah deals" is the other command, not a search for an item called deals.
  if (typed && typed.toLowerCase() === 'deals') return commands;
  if (typed) {
    // "ah linen" or "ah: search linen" is an ask for exactly this, so it leads.
    commands.push({ id: 'ah:search', title: `AH: search ${short(typed)}`, group: 'Auction House', icon: 'search', detail: 'Prices in the Auction House widget', live: 800, run: () => open('search', typed) });
  } else if (base === 'wow' && query.trim()) {
    // In the WoW preset, whatever is typed can be looked up, below anything the words already match.
    commands.push({ id: 'ah:search', title: `AH: search ${short(query.trim())}`, group: 'Auction House', icon: 'search', detail: 'Prices in the Auction House widget', live: -80, run: () => open('search', query.trim()) });
  }
  return commands;
};

// ---- automations ----

const automationCommands: Provider = ({ actions }) => [
  {
    id: 'automation:add',
    title: 'Add an automation',
    group: 'Automations',
    icon: 'zap',
    detail: 'When something happens, do something',
    keywords: 'rule trigger when then automatic',
    run: actions.addAutomation,
  },
];

export const providers: Provider[] = [
  presetCommands,
  panelCommands,
  widgetCommands,
  clipCommands,
  streamCommands,
  goLiveCommands,
  launcherCommands,
  webCommands,
  downloadCommands,
  driveCommands,
  obsCommands,
  wowCommands,
  focusCommands,
  ahCommands,
  automationCommands,
];

/** Every command that can run right now. */
export function buildCommands(ctx: PaletteContext, from: Provider[] = providers): Command[] {
  return from.flatMap((provider) => provider(ctx)).filter((c) => c.enabled !== false);
}

// ---- searching and listing ----

export interface Row {
  command: Command;
  /** Where the typed letters matched the title, for highlighting. */
  positions: number[];
  score: number;
}

export interface Section {
  group: string;
  rows: Row[];
}

/** How much a recent command is pushed up a search: the latest most. */
export const recentBoost = (index: number) => (MAX_RECENT - index) * 1.25;

/** Words that aren't the title but still find the command: its heading and keywords. Weaker than the title. */
const OTHER_WORDS_PENALTY = 15;

/**
 * What the palette lists. With nothing typed: the recently used commands first, under "Recent",
 * then every heading. With something typed: the commands that match, best first, each heading
 * with its best match on top, and recent commands nudged up.
 */
export function arrange(commands: Command[], query: string, recent: string[]): Section[] {
  const text = query.trim();
  const boost = (c: Command) => (c.live === undefined && recent.includes(c.id) ? recentBoost(recent.indexOf(c.id)) : 0);

  if (!text) {
    const byId = new Map(commands.filter((c) => c.live === undefined).map((c) => [c.id, c]));
    const used = recent.map((id) => byId.get(id)).filter((c): c is Command => Boolean(c));
    const sections: Section[] = [];
    if (used.length > 0) sections.push({ group: 'Recent', rows: used.map((command) => ({ command, positions: [], score: 0 })) });
    const taken = new Set(used.map((c) => c.id));
    return [...sections, ...grouped(commands.filter((c) => !taken.has(c.id)).map((command) => ({ command, positions: [], score: 0 })))];
  }

  const rows: Row[] = [];
  for (const command of commands) {
    if (command.live !== undefined) {
      rows.push({ command, positions: [], score: command.live });
      continue;
    }
    let match: Match | null = fuzzyMatch(text, command.title);
    if (!match) {
      const other = fuzzyMatch(text, `${command.group} ${command.keywords ?? ''}`);
      match = other && { score: other.score - OTHER_WORDS_PENALTY, positions: [] };
    }
    if (match) rows.push({ command, positions: match.positions, score: match.score + boost(command) });
  }
  const sections = grouped(rows);
  for (const s of sections) s.rows.sort((a, b) => b.score - a.score);
  // Stable, so equal headings keep their usual order.
  return sections.sort((a, b) => b.rows[0].score - a.rows[0].score);
}

function grouped(rows: Row[]): Section[] {
  const order = (g: string) => {
    const i = (GROUPS as readonly string[]).indexOf(g);
    return i < 0 ? GROUPS.length : i;
  };
  const sections = new Map<string, Section>();
  for (const row of rows) {
    const section = sections.get(row.command.group) ?? { group: row.command.group, rows: [] };
    section.rows.push(row);
    sections.set(row.command.group, section);
  }
  return [...sections.values()].sort((a, b) => order(a.group) - order(b.group));
}
