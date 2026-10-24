import type { PresetDef } from '../presets';
import { overlay } from '../state/overlay';
import { type BoardId, isWidgetId, uid, type Widget } from '../state/model';
import { calendar } from './calendar';
import { camera } from './camera';
import { character } from './character';
import { chat } from './chat';
import { clock } from './clock';
import { countdown } from './countdown';
import { damage } from './damage';
import { discord } from './discord';
import { downloads } from './downloads';
import { drive } from './drive';
import { focus } from './focus';
import { game } from './game';
import { gmail } from './gmail';
import { hud } from './hud';
import { launcher } from './launcher';
import { match } from './match';
import { media } from './media';
import { network } from './network';
import { notes } from './notes';
import { notifications } from './notifications';
import { obs } from './obs';
import { progress } from './progress';
import { quests } from './quests';
import { record } from './record';
import { run } from './run';
import { scoreboard } from './scoreboard';
import { slots } from './slots';
import { steam } from './steam';
import { system } from './system';
import { teams } from './teams';
import { text } from './text';
import { twitch } from './twitch';
import { weather } from './weather';
import { web } from './web';
import { appWindow } from './window';
import { type AnyWidgetDef, type Category, CATEGORIES, isSingle } from './types';

// The widget library: every kind of thing that can sit on the board, in the order the sidebar
// lists them within a category. Adding a widget is its folder plus one line here (see README.md).

export const WIDGETS: readonly AnyWidgetDef[] = [
  // Gaming
  game,
  slots,
  run,
  progress,
  hud,
  discord,
  network,
  system,
  // Streaming
  camera,
  chat,
  obs,
  twitch,
  appWindow,
  // Productivity
  notes,
  focus,
  countdown,
  launcher,
  calendar,
  gmail,
  drive,
  text,
  // Media & info
  media,
  clock,
  weather,
  notifications,
  web,
  downloads,
  // A game's own
  match,
  record,
  teams,
  scoreboard,
  damage,
  character,
  quests,
  steam,
];

export { CATEGORIES };
export type { Category };

const BY_KIND = new Map(WIDGETS.map((def) => [def.kind, def]));

/** The definition of a kind, or undefined for one this version doesn't know (from a newer or hand-edited file). */
export const widgetDef = (kind: string): AnyWidgetDef | undefined => BY_KIND.get(kind);

/** What sits on the board under this id: a single panel's kind, or the kind of the widget with that id. */
export function boardDef(id: BoardId, widgets: readonly Widget[]): AnyWidgetDef | undefined {
  if (isWidgetId(id)) {
    const widget = widgets.find((w) => w.id === id);
    const def = widget && BY_KIND.get(widget.kind);
    return def && !isSingle(def) ? def : undefined;
  }
  const def = BY_KIND.get(id);
  return def && isSingle(def) ? def : undefined;
}

/** Whether `id` can be on a board with these widgets: a single panel's kind, or a widget that exists. */
export const isKnownBoardId = (id: BoardId, widgets: readonly Widget[]) => boardDef(id, widgets) !== undefined;

const UNKNOWN_SIZE = { w: 4, h: 3, minW: 2, minH: 2 };

/** How big a board item starts and shrinks to. An unknown one gets a small size so a layout can still hold it. */
export function sizeOf(id: BoardId, widgets: readonly Widget[] = []) {
  return boardDef(id, widgets) ?? UNKNOWN_SIZE;
}

/** The panels there can only be one of in a preset, and the kinds you can add any number of. */
export const SINGLE_KINDS = WIDGETS.filter(isSingle).map((def) => def.kind);
export const MULTI_KINDS = WIDGETS.filter((def) => !isSingle(def)).map((def) => def.kind);

/** What a single panel is called in this preset: its own wording ("Build" for SMITE's slots), else the kind's name. */
export function panelTitle(preset: PresetDef, kind: string): string {
  return preset.titles[kind] ?? BY_KIND.get(kind)?.name ?? kind;
}

/** A widget's title: its own, else its kind's name. */
export function widgetTitle(w: Widget): string {
  return w.title || BY_KIND.get(w.kind)?.name || w.kind;
}

/** What a board item is called here, for the sidebar, toasts and the palette. */
export function boardTitle(preset: PresetDef, id: BoardId, widgets: readonly Widget[]): string {
  if (!isWidgetId(id)) return panelTitle(preset, id);
  const widget = widgets.find((w) => w.id === id);
  return widget ? widgetTitle(widget) : 'Widget';
}

// ---- widgets: creating them, and cleaning what was saved ----

/**
 * A widget's settings from whatever was saved: the kind's defaults with the saved values laid over
 * them (keys the kind doesn't keep are dropped, wrong types fall back to the default), then the
 * kind's own `clean`. This is also how the old one-struct-for-all settings are read: each kind
 * picks out its own keys.
 */
export function settingsFor(def: AnyWidgetDef, saved: unknown): Record<string, unknown> {
  if (isSingle(def)) return {};
  const settings = overlay(def.defaults() as Record<string, unknown>, saved);
  return def.clean ? def.clean(settings) : settings;
}

/** A new widget of a kind that can be added any number of times. `settings` are laid over its defaults. */
export function newWidget<S extends object = Record<string, unknown>>(
  kind: string,
  init: { id?: Widget['id']; title?: string; settings?: Partial<S> } = {},
): Widget<S> {
  const def = BY_KIND.get(kind);
  if (!def || isSingle(def)) throw new Error(`"${kind}" is not a widget you can add more than once`);
  return {
    id: init.id ?? `wdg-${uid()}`,
    kind,
    title: init.title ?? '',
    settings: { ...(def.defaults() as S), ...init.settings },
  };
}

/** A widget as it goes into a shared preset: what is personal or only means something on this PC is taken out. */
export function widgetForSharing(w: Widget): Widget {
  const def = BY_KIND.get(w.kind);
  if (!def || isSingle(def) || !def.forSharing) return w;
  return { ...w, settings: def.forSharing(w.settings) as Record<string, unknown> };
}
