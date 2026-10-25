import type { ComponentType } from 'react';
import type { IconName } from '../components/Icon';
import type { MenuEntry } from '../components/Menu';
import type { PresetDef } from '../presets';
import type { AppState, BoardId, PresetData, PresetId, Widget } from '../state/model';
import type { Mutate, MutatePreset } from '../state/useAppState';

// What a widget definition looks like. Every thing that can sit on the board, from the Game panel
// to a Clock, is one of these (see registry.ts for the list and README.md in this folder for how
// to add one). This file is types and one helper; it imports nothing that draws.

/** The sidebar groups the library by these, in this order. A game's own widgets get its name. */
export const CATEGORIES = ['Gaming', 'Streaming', 'Productivity', 'Media & info', 'SMITE 2', 'WoW', 'Steam'] as const;
export type Category = (typeof CATEGORIES)[number];

/** What every panel on the board is given. */
export interface PanelContext {
  /** Its board id: the kind for a single panel, 'wdg-…' for a widget. */
  id: BoardId;
  /** What it is called here: the preset's own wording for a single panel, the widget's own title for a widget. */
  title: string;
  state: AppState;
  /** The data of the preset showing. */
  data: PresetData;
  /** The built-in preset it is, or is a copy of. */
  def: PresetDef;
  mutate: Mutate;
  mutatePreset: MutatePreset;
}

/** What a widget that draws its own panel is given: the context, and its own record and settings. */
export interface WidgetProps<S extends object> extends PanelContext {
  widget: Widget<S>;
  /** What its kind is called (the title when the widget has none of its own). */
  name: string;
  settings: S;
  /** Changes some of its settings (saved straight away). */
  set: (patch: Partial<S>) => void;
}

/** What a widget's body is given; the panel around it (title, hide button, menu) is drawn for it. */
export interface BodyProps<S extends object> {
  widget: Widget<S>;
  settings: S;
  set: (patch: Partial<S>) => void;
  /** Edit mode; false on stream. */
  editing: boolean;
  /** The side view its ⋯ menu entry toggles is showing (see `menu`). */
  open: boolean;
  close: () => void;
}

/** What a widget's settings form is given; the form's Done button is drawn for it. */
export interface SettingsProps<S extends object> {
  settings: S;
  set: (patch: Partial<S>) => void;
}

/** What `menu` is given to build the ⋯ menu from. */
export interface MenuContext {
  open: boolean;
  toggle: () => void;
}

/** What is the same for every definition. */
interface Common {
  /** The id: a panel's board id and the `kind` of a widget's record. Lowercase, one word. */
  kind: string;
  name: string;
  /** One plain line for the library. */
  hint: string;
  icon: IconName;
  category: Category;
  /** Extra words that find it when searching the library. */
  keywords?: string;
  /** Presets that recommend it: the library lists it first under "Recommended for …". */
  presets?: PresetId[];
  /** The size it starts at, and the smallest it can shrink to, in board cells. */
  w: number;
  h: number;
  minW: number;
  minH: number;
}

/** A panel there is only one of in a preset. Its data is part of the preset's own data (PresetData). */
export interface SingleDef extends Common {
  single: true;
  panel: ComponentType<PanelContext>;
}

interface InstanceCommon<S extends object> extends Common {
  single?: false;
  /**
   * Only one of it makes sense on a board (a workbench like the Auction House). The library and
   * the palette then show it instead of adding a second one. Its settings still live in the widget.
   */
  onlyOne?: boolean;
  /** Its settings when it is added. Every key it keeps is here; nothing else is saved. */
  defaults: () => S;
  /** Puts right settings that came from outside (a hand-edited or shared file); they are laid over `defaults` first. */
  clean?: (settings: S) => S;
  /** Takes out what is personal or only means something on this PC, for a shared preset. */
  forSharing?: (settings: S) => S;
  /** Its settings form, shown in the panel while editing, when it has not been set up or the menu opens it. */
  settings?: ComponentType<SettingsProps<S>>;
  /** True when there is nothing to show yet: the panel is hidden in stream mode, and edit mode shows the form. */
  empty?: (settings: S) => boolean;
  /** The ⋯ menu. When it has a settings form and no `menu`, that is a "Settings" entry. */
  menu?: (c: MenuContext) => MenuEntry[];
}

/** A widget you can add any number of times, drawn inside the library's own panel. */
export interface BodyDef<S extends object> extends InstanceCommon<S> {
  body: ComponentType<BodyProps<S>>;
  panel?: undefined;
}

/** A widget you can add any number of times that draws its whole panel itself (see frame.tsx). */
export interface PanelDef<S extends object> extends InstanceCommon<S> {
  panel: ComponentType<WidgetProps<S>>;
  body?: undefined;
}

export type WidgetDef<S extends object = object> = SingleDef | BodyDef<S> | PanelDef<S>;

/**
 * A definition once it is in the registry, with the settings type forgotten: the registry holds
 * kinds of every settings type, and reads a widget's settings only through its own definition.
 */
export type AnyWidgetDef = SingleDef | BodyDef<any> | PanelDef<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Checks a definition against its settings type, which is why every widget folder wraps its in this. */
export function defineWidget<S extends object>(def: SingleDef | BodyDef<S> | PanelDef<S>): AnyWidgetDef {
  return def;
}

export const isSingle = (def: AnyWidgetDef): def is SingleDef => def.single === true;
