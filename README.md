# Uncbox

Everything you need while you play, on one screen: the game in a big window, with your camera,
Twitch chat, run stats, notes and any other app's window arranged around it. Built for
streaming, hosted on your own PC.

Each game gets a preset with its own panels, layout and look. A preset's theme (colors, fonts,
corner radius, frame style) applies to every panel on the board, captured windows included, so
the whole screen reads as one piece.

| Preset | Panels it adds | Look |
| --- | --- | --- |
| **Pokémon** | Party with KO markers, 8 badges, deaths/resets, run timer | Coral and yellow, rounded |
| **SMITE 2** | God, role and live K/D/A; session W/L with win rate, streak and match log; 6-slot build | Gold on navy, sharp corners with gilded brackets |
| **WoW Forever** | Character sheet with class color, level and XP bars, zone, gold, hardcore flag; raids; /played | Amber and epic purple, framed |

Every panel can be added to any preset from the sidebar.

## Quick start

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

Open <http://localhost:5170> in Chrome or Edge. `npm start` builds and serves the app,
`npm run serve` skips the build, and `npm run dev` runs with hot reload.

Changes save to `data/state.json` (git-ignored) as you make them. Saves from version 0.1
(PokéStream) are moved into the Pokémon preset automatically.

## Arranging the board

The board is a 24 × 24 grid stretched to fill the window, so a layout looks the same at any
resolution.

- **Move** a panel by dragging its title bar. **Resize** from its right or bottom edge.
- **Hide** a panel with the × in its title bar; bring it back from **Panels** in the sidebar.
- **Reset layout** puts the preset's panels back where they started.

## The game window

Hover the game window for its toolbar.

| Source | Use it for | Notes |
| --- | --- | --- |
| **Capture device** | Consoles through a capture card | Most cards can only be opened by one app at a time. If OBS already has it, use the chroma slot. |
| **Window** | Emulators and PC games | The browser asks which window to share, again after every reload. |
| **Chroma slot** | Keeping the game capture in OBS | A flat color you key out in OBS, with the game capture layered underneath. Lowest latency. |

**Crop** trims menu bars and black borders. **Fit to game** resizes the window to the picture's
shape, which removes the black bars around a GBA or DS screen. **Sharp pixels** keeps pixel art
crisp.

## App windows

**Add app window** in the sidebar adds a panel that shows any window on your PC: Discord,
Spotify, a popped-out chat, a guide. Add as many as you like; each has its own name, crop and
fit, and takes on the preset's theme.

They are view only. A web page can show another window but cannot pass clicks or typing to it,
and the browser asks you to pick each window again after a reload.

## Twitch chat

Type your channel into the chat panel. It connects anonymously and is read-only, so no login is
needed. Bot accounts (Nightbot, StreamElements and similar) are hidden by default; the **BOT**
button shows them.

## Going live with OBS

1. Open the dashboard in a window without browser chrome:
   ```bash
   start msedge --app=http://localhost:5170
   ```
2. Press **Stream mode** (or `F8`). The sidebar and edit controls go away and the layout locks;
   hovering a panel brings its controls back. `Esc` or `F8` returns to editing.
   `?stream=1` on the URL opens straight into stream mode.
3. In OBS, add a **Window Capture** of that window.
4. Using the chroma slot: add a **Chroma Key** filter to the window capture, match the slot's
   color, and put your game capture source underneath.

The dashboard is video only; capture game audio in OBS as usual.

## Controlling it from another device

Every open copy stays in sync, so a phone or second monitor can update counters while the
captured window stays clean. The server only listens on this PC by default. To open it to your
network:

```powershell
$env:HOST = "0.0.0.0"; npm start
```

Then visit `http://<your-pc-ip>:5170`. There is no login, so only do this on a network you
trust. `--port=` and `--data=<folder>` change the port and where state is saved.

## Project layout

```
server/index.mjs          static files, /api/state, live sync over /api/events
src/presets.ts            preset definitions: titles, default layouts, starting data
src/state/                state shape, loading and migration, the save/sync hook
src/twitch.ts             read-only Twitch chat client
src/media.ts              capture device and window capture hooks
src/components/Board.tsx  the draggable grid
src/components/*Panel.tsx one file per panel
src/styles.css            theme tokens and all styling
```
