# The widget library

Everything that can sit on the board is a **widget**: the Game panel, Chat, Notes, a Clock, the
weather, OBS, an app window. They are all defined the same way, in one place, and the sidebar's
**Get More Widgets** is the library you browse to add them. There is no other list of panels or
widget types anywhere in the code. If you are looking for where something is registered, it is
`registry.ts` and nothing else.

```
src/widgets/
  registry.ts      the list of every widget, and lookups (definition by kind, sizes, titles, new widgets)
  types.ts         what a definition is (WidgetDef) and defineWidget()
  frame.tsx        the panel a widget sits in (title, hide button, ⋯ menu, settings form)
  render.tsx       renderPanel(): what the board draws for an id
  library.ts       what the sidebar lists: search, categories, "Recommended for …"
  shared/          small things several widgets use (useNow, usePoll, the Google sign-in parts)
  <kind>/          one folder per widget
    index.ts       its definition: the one thing the registry imports
    settings.ts    its settings type, defaults and clean-up (widgets you can add more than once)
    <Name>.tsx     its component(s)
    <other>.ts     its helpers, with their *.test.ts next to them
```

Generic UI that is not a widget (the board, `Panel`, `Menu`, `Icon`, the sidebar, dialogs) stays
in `src/components/`. The sidebar's library list is `src/components/WidgetLibrary.tsx`; it only
draws what `library.ts` works out.

## Two sorts of widget

**Single panels** (`single: true`): there is only one in a preset, and its data is part of the
preset's own data (`PresetData` in `src/state/model.ts`: `data.notes`, `data.game`, `data.match`…),
because that is how presets, sharing and the WoW/SMITE readers have always worked. Their id on the
board is their `kind` (`'game'`, `'chat'`, `'notes'`). The library offers **Add** until one is on
the board, then **On screen** and **Show**.

**Widgets** (the default): add as many as you like. Each one is a record in `data.widgets`:

```ts
{ id: 'wdg-3k9x2m1a', kind: 'weather', title: '', settings: { place: 'Austin, Texas', lat: 30.27, lon: -97.74, celsius: false } }
```

The `id` is what the layout (`data.layout`) refers to. `title: ''` means "use the kind's name".
`settings` belong to the kind alone: the kind's `defaults()` say which keys exist, and loading a
save lays the saved values over them, so a key a save lacks gets its default and a key the kind
doesn't have is dropped. An app window is a widget of the kind `window`.

## A definition

Every widget folder exports one definition made with `defineWidget`, which checks it against the
widget's settings type:

| Field | |
| --- | --- |
| `kind` | The id: lowercase, one word. For a single panel it is also the layout id, so never rename one. |
| `name`, `hint`, `icon` | Shown on the library's card. `hint` is one plain line. `icon` is a name from `components/Icon.tsx`. |
| `category` | `Gaming`, `Streaming`, `Productivity`, `Media & info`, or a game's own (`SMITE 2`, `WoW`, `Steam`). The list is `CATEGORIES` in `types.ts`; a new game gets a name there. |
| `keywords` | Extra words that find it in the library's search ("pomodoro" finds the Focus timer). |
| `presets` | The presets that recommend it. See below. |
| `w`, `h`, `minW`, `minH` | The size it starts at and the smallest it can shrink to, in board cells (the board is 24 × 24). |
| `single` | `true` for a panel there is only one of. |
| `defaults()` | Its settings when added. Returns a new object each time. Widgets only. |
| `clean(settings)` | Puts right settings that came from outside (a hand-edited or shared file). The saved values are already laid over `defaults()`; this checks them (a web address is a web address, a number is in range). Optional. |
| `forSharing(settings)` | Takes out what is personal or only means something on this PC, when a preset is exported. Optional. |
| `body` / `panel` | What draws it. Exactly one. See below. |
| `settings` | A form for its settings, shown in the panel while editing. Optional. |
| `empty(settings)` | True when there is nothing to show yet. The panel is hidden in stream mode, and in edit mode the settings form opens by itself. Optional. |
| `menu({ open, toggle })` | The panel's ⋯ menu. Without it, a widget with a settings form gets "Settings". Optional. |

### `body` or `panel`

- **`body`** is for most widgets. You write what goes inside the panel; the library draws the
  panel around it: the title (editable while editing), the hide button, the ⋯ menu, and the
  settings form with its Done button. Your component gets `{ widget, settings, set, editing, open, close }`.
  `set({ celsius: true })` saves straight away. `open` is whether the ⋯ menu's entry has been
  toggled on: the settings form opens with it, and a body can use it for a view of its own (the
  Launcher's "Edit tiles", Drive's account view).
- **`panel`** is for a widget that draws its whole panel itself, because it needs hooks in the
  header or has to stay mounted while its settings are open (Web, OBS, App window, and all the
  single panels). Inside it, use `<WidgetFrame>` from `frame.tsx` to get the same title,
  hide button and menu without writing them again. A single panel gets the
  `PanelContext` (`state`, `data`, `def` (the preset), `title`, `mutate`, `mutatePreset`); a
  widget gets that plus `widget`, `settings` and `set`.

## Adding a widget

One folder, one line in the registry. Say you want a "Stopwatch":

1. `src/widgets/stopwatch/settings.ts`

   ```ts
   export type StopwatchSettings = {
     /** When it was started (ms since 1970), or 0 if stopped. */
     startedAt: number;
   };

   export const defaultStopwatchSettings = (): StopwatchSettings => ({ startedAt: 0 });
   ```

2. `src/widgets/stopwatch/StopwatchWidget.tsx`

   ```tsx
   import { useNow } from '../shared/useNow';
   import type { BodyProps } from '../types';
   import type { StopwatchSettings } from './settings';

   export function StopwatchBody({ settings, set }: BodyProps<StopwatchSettings>) {
     const now = useNow(1000);
     const seconds = settings.startedAt ? Math.floor((now - settings.startedAt) / 1000) : 0;
     return (
       <div className="widget-clock">
         <strong>{seconds}s</strong>
         <button className="btn btn--small" onClick={() => set({ startedAt: settings.startedAt ? 0 : Date.now() })}>
           {settings.startedAt ? 'Stop' : 'Start'}
         </button>
       </div>
     );
   }
   ```

3. `src/widgets/stopwatch/index.ts`

   ```ts
   import { defineWidget } from '../types';
   import { defaultStopwatchSettings } from './settings';
   import { StopwatchBody } from './StopwatchWidget';

   export const stopwatch = defineWidget({
     kind: 'stopwatch',
     name: 'Stopwatch',
     hint: 'Time anything, with one button',
     icon: 'timer',
     category: 'Productivity',
     keywords: 'timer lap',
     presets: ['desk'],
     w: 4,
     h: 3,
     minW: 3,
     minH: 2,
     defaults: defaultStopwatchSettings,
     body: StopwatchBody,
   });
   ```

4. In `registry.ts`: `import { stopwatch } from './stopwatch';` and add `stopwatch` to `WIDGETS`,
   under its category.

That is all. It is now in the library (searchable, with its category chip and its card), in the
command palette as "Add widget: Stopwatch", loads and saves with the rest of a preset (an
unknown or hand-edited `kind` is dropped, never a crash), and is drawn by the smoke test in every
preset's theme and checked by the accessibility test, both of which loop over `WIDGETS`.
`registry.test.ts` checks the definition itself (a unique kind, a size that fits the board,
`defaults` that survive `clean`).

Things to know when writing one:

- Name it for what it does in the board's language: the UI is plain and friendly, no jargon.
- Panels must look right in every preset theme: use the colors and classes in `styles.css`
  rather than your own. Look at a similar widget first.
- Anything that touches this PC (launching, files, secrets) goes through the local server and is
  `isLocal`-only; secrets stay on the server and never go in `settings`, which are saved with the
  preset and exported with it.
- Live data from the server comes over the shared event stream (`src/events.ts`); see
  `media/media.ts` or `network/network.ts` for the pattern, including `keepAlive` so the server
  stops measuring when nothing is looking.
- Pure logic (parsing, formatting, a timer's maths) goes in its own `.ts` file with a `.test.ts`
  next to it, not inside the component.
- If other code needs your settings typed (the Focus timer is read by Automations and the
  palette), export the type and a guard such as `isFocusWidget(w)` from the widget's folder.

## How presets recommend widgets

A widget lists the presets that recommend it in `presets`, for example
`presets: ['smite2', 'wow']`. The library lists a preset's recommended widgets first, under
"Recommended for <preset>", and `src/presets.test.ts` checks that every preset has some and that every
panel a preset's layout uses is recommended by it.

A preset's own `layout` (in `src/presets.ts`) is the board it starts with, and `widgets` there are
the widgets it brings (`{ id: 'wdg-deskweb', kind: 'web', settings: { homeUrl: '…' } }`, with the
rest of the settings coming from the kind's defaults). Layouts must fill the 24 × 24 board without
gaps or overlaps, with every item at least its kind's minimum size; `src/presets.test.ts` checks
every preset. `titles` renames a single panel for that preset ("Build" for SMITE 2's Party).

**Reset layout** puts the preset's layout and widgets back; the preset's own widgets keep the
settings you gave them, widgets you added go.

## Loading saved data

`src/state/hydrate.ts` cleans everything that is loaded (saved state, imported preset files,
gallery presets) and never throws on what it finds:

- a widget whose `kind` the library doesn't know, or that is a single panel, is dropped;
- a layout item that isn't a known panel or an existing widget is dropped, as are repeats;
- a layout that overlaps or runs off the board is squeezed back on, or replaced by the preset's own;
- a layout with nothing usable left becomes the preset's own (a board you emptied yourself stays
  empty), and a widget that isn't on the board is dropped;
- each widget's settings are the kind's `defaults()` with the saved values over them, then `clean`.

### Files from before the library

Saves and `.uncbox` files version 1 (and saves before that change) had the widget's kind as
`type`, kept every widget's settings in one struct, and kept app windows in a `windows` list with
`win-…` ids. Loading them still works: `hydratePreset` reads `type` as `kind`, each kind takes
its own keys out of the old struct, and a window becomes a `window` widget with the id `wdg-…`
(the layout is updated to match). Preset files are written as version 2 and both versions are
read. `src/state/legacy.test.ts` loads the four gallery files as they were in version 1 and checks
they come out the same as the current ones.
