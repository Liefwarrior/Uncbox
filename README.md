<div align="center">

<img src="assets/branding/uncbox-icon.svg" alt="" width="88" height="88">


[![Buy Me a Coffee](https://img.shields.io/badge/Buy_me_a_coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/liefwarrior)


</div>

## Presets

Note:  These are planned integrations, they may not work and may result in the sudden loss of DKP

<table>
  <tr>
    <td width="25%"><img src="docs/screenshots/pokemon.webp" alt="Pokémon preset"></td>
    <td width="25%"><img src="docs/screenshots/smite2.webp" alt="SMITE 2 preset"></td>
    <td width="25%"><img src="docs/screenshots/wow.webp" alt="WoW Forever preset"></td>
    <td width="25%"><img src="docs/screenshots/terminal.webp" alt="Terminal preset"></td>
  </tr>
  <tr>
    <td><b>Pokémon</b><br>Party with fainted markers, 8 badges, deaths and resets, run timer.</td>
    <td><b>SMITE 2</b><br>Live K/D/A, session record with win rate and streak, item build.</td>
    <td><b>WoW Forever</b><br>Character sheet with class color, level and XP, a live <a href="integrations/wow/README.md">quest log</a>, raids, /played.</td>
    <td><b>Terminal</b><br>Any game, dressed as PowerShell in Windows Terminal.</td>
  </tr>
</table>

Three more, without screenshots yet:

- **Minecraft Dungeons II**: torch-lit stone and emerald. A **Stats** panel reads your emeralds,
  level and more straight off the game's screen, live (see [Stats](#stats-read-off-the-screen)).
  The session timer starts when the game does. Also party, missions and deaths.
- **Steam Big Picture**: Steam's own look. A **Steam** panel shows what you're playing (live from
  the Steam app), its art, your session and total time, and achievements as they unlock. Between
  games, it shows your recent games.
- **Desk**: a calm slate-and-teal board for working between games, with no game on it. A big Web
  widget, Drive, Focus timer, Launcher, Now playing, Notifications, Clock, Weather and Notes.

Every panel works in every preset, so any game can borrow from the others. Each preset also picks
its own background in the sidebar: animated shapes or a pattern, drawn in the preset's colors.

## Download (Windows)

Run `Uncbox-Setup-<version>.exe` and choose Install: it goes in `%LOCALAPPDATA%\Programs\Uncbox` for
you only (no admin rights), with a Start menu shortcut and an entry in Settings > Apps to uninstall
it. Or unzip `Uncbox-<version>-win-x64.zip` anywhere and double-click `Uncbox.exe` (it offers to
install too; "Just run it" skips that). Either way it brings its own copy of Node.js. It keeps your
settings in `%LOCALAPPDATA%\Uncbox`, so replacing or deleting the app folder never loses them, and
uninstalling keeps them unless you ask. It checks GitHub once a day for a newer version and shows a
quiet "Download" link; it never updates itself. Packaging it yourself is
`npm run package` (see [native/README.md](native/README.md#packaging)).

## Get started

You need [Node.js](https://nodejs.org) 20 or newer, and Chrome or Edge.

```bash
npm install
npm start
```

Open <http://localhost:5170>. Want it at <https://unc.box> instead? Run `npm run setup-domain`
once (Windows asks for permission), then restart Uncbox. `npm run remove-domain` undoes it.

The **Get set up** list in the sidebar walks you through the rest:

<img src="docs/screenshots/editing.webp" alt="Editing view: the sidebar with game presets, the setup list and the panels on screen" width="100%">

1. **Pick your game** at the top of the sidebar.
2. **Show your game.** Choose a capture card (consoles), a window (emulators and PC games), or a
   green screen to key out in OBS.
3. **Turn on your camera**, **add your Twitch chat** and **connect Discord.** Click a step and
   Uncbox points at the panel that needs you. Not using one? Switch it off under **On screen**.
4. **Press Stream mode** (or `F8`). The window goes full screen and the edit controls hide.
   `Esc` brings everything back.

Something amazing just happened? Press **=** to save the last 60 seconds of your game as a clip.
See [Clips](#clips).

## The Uncbox app (Windows)

Rather run Uncbox as an app? `npm run app` opens it full screen, starts the server for you, and
keeps it in the tray when minimized. In the app, the game panel can **Play here**: your game's own
window moves into the panel, so you play it right inside the dashboard with mouse, keyboard or
controller, at its full frame rate. It needs the [.NET 10 SDK](https://dotnet.microsoft.com/download)
to build. See [native/README.md](native/README.md).

## Going live with OBS

1. Open Uncbox in its own window. In Edge: `start msedge --app=http://localhost:5170`
2. Press **Stream mode**.
3. In OBS, add a **Window Capture** of that window.
4. Using the green screen? Add a **Chroma Key** filter to that capture and put your game capture
   underneath.

Uncbox is video only. Capture game audio in OBS as usual.

## Guide

### Arranging the board

The board is a 24 × 24 grid that fills the window, so a layout looks the same at any size.

- **Move** a panel by dragging its title. **Resize** it from the right or bottom edge.
- **⋯** in a panel's title has its settings, all in plain words.
- **×** takes a panel off the board. An **Undo** shows up for a few seconds, and **Get More
  Widgets** in the sidebar puts it back any time.
- **On screen** in the sidebar lists what is on the board. **Show** points at a panel (handy on a
  busy board), and **×** takes it off.
- **Reset layout** puts the preset's panels and widgets back where they started. Widgets you
  added go; the settings of the preset's own widgets stay.

### Sharing presets

Your setup is a file you can hand to someone, and theirs can become one of yours. It's the start
of a community gallery: presets that people post and others can try.

- **Export.** **Export this preset** in the sidebar (or **Export** in a preset's **⋯** menu)
  downloads `<Name>.uncbox`.
- **Import.** **Import a preset** in the sidebar picks a `.uncbox` file, or just drop one anywhere
  on the dashboard. It arrives as a new preset of its own, in the same style as the game it was
  made for, with its own name (a number is added if you already have that name). It never
  replaces anything of yours.
- **Browse presets** in the sidebar (or Ctrl K, "Browse presets") opens the gallery: search, filter
  by tag, and **Install** adds a preset as one of yours. Presets live in this repo's `gallery/`
  folder; `gallery/README.md` says how to add yours with a pull request. Set `UNCBOX_GALLERY_URL`
  (a web address or a folder on your PC) to read a different copy.
- **Save as a new preset** copies the preset you're on, with everything in it, so you can try
  changes without losing the original. Presets of your own show up under the built-in ones, with
  **Rename**, **Export** and **Delete** (with an **Undo**) in their **⋯** menu.

A shared file has the layout, background, panel titles, slots (names, notes and uploaded
pictures), counters and milestones (reset to zero and unticked), notes, widgets with their
settings, app window panels and the game window's fit and crop. What's personal or only true on
your PC is left out, so a file is safe to post:

- Which camera, capture card or game window you use (the panel asks again), and the run timer.
- Your match and record history, your K/D/A and any numbers the Stats panel read.
- The WoW character's name, realm, guild, gold and level, and the quest log. Race, class and
  hardcore stay, since they set how the character panel looks.
- A weather widget's place, which is often home.
- Slot pictures that are links to other sites (only uploaded pictures travel in the file).

Files over 5 MB are refused, and everything in a file is checked like Uncbox's own saved data, so
a hand-edited one can't put odd values in.

### The game window

Hover the game window for its toolbar.

| Source | Use it for | Good to know |
| --- | --- | --- |
| **Capture card** | Consoles | Most cards can only be open in one app. If OBS already has it, use the green screen. |
| **Window** | Emulators and PC games | The browser asks which window to show, again after every reload. |
| **Green screen** | Keeping your game capture in OBS | A flat color to key out, with the game layered underneath. Lowest delay. |

**Crop** trims menu bars and black borders. **Fit to game** sizes the window to the picture,
which removes the black bars around a GBA or DS screen. **Sharp pixels** keeps pixel art crisp.

### Get More Widgets

Everything on the board, from the Game panel to a Clock, is a widget from one library, and **Get
More Widgets** in the sidebar is where you browse it: search by name or what it does, narrow by
category (Gaming, Streaming, Productivity, Media & info, and a game's own: SMITE 2, WoW, Steam),
and **Add**. The widgets your preset recommends come first, under **Recommended for** its name.

Some are panels there is only one of in a preset (Game, Chat, Notes…); once one is on the board
its card says **On screen** and **Show**. The others you can add as many times as you like. In
the command palette (Ctrl K) they are **Add widget: …**.

Adding a widget fits it on the board by making room, so nothing ever ends up out of sight.
Developers: [src/widgets/README.md](src/widgets/README.md) is how the library works and how to
add a widget.

### App windows

**App window** in the library shows any window on your PC (Spotify, a guide, a popped-out chat)
in a panel that matches the preset. Add as many as you like.

They are view only: a web page can show another window but can't click or type into it, and the
browser asks you to pick each window again after a reload.

### Widgets

These small panels in the library can be added as many times as you like:

| Widget | Shows |
| --- | --- |
| **Clock** | The time here or in any time zone. |
| **Weather** | Now and today's high and low for any place, from [Open-Meteo](https://open-meteo.com) (no account; only the place is sent). |
| **Now playing** | The song or video playing on this PC, with its cover: anything that shows in Windows' media controls (Spotify, YouTube in a browser…). |
| **Notifications** | Windows notifications as they arrive. Titles only unless you ask for the message too, and you can limit it to some apps. It's on stream, so leave private apps out. Only shown on this PC. Needs Node.js 22.5 or newer. |
| **System** | CPU, graphics card (NVIDIA) and memory load. |
| **Ping & FPS** | Your ping (how long a connection to 1.1.1.1 or any host you choose takes), jitter, packet loss and, if you like, the ping to your router. While SMITE 2 is running it shows the game's own ping and frame rate instead, with the 1% low. Only measures while the widget is on screen. |
| **Countdown** | Time left until a date you pick. |
| **Text** | Any words you like. |
| **Twitch stream** | Live or offline with uptime, viewers (and a small graph), followers, subs and your newest followers. In edit mode you can change the stream's title and category from it. Needs a one-time sign-in, see [Twitch stream widget](#twitch-stream-widget). |

Settings are in each widget's **⋯** menu, and you can rename any of them.

### Stats read off the screen

The **Stats** panel (recommended for Minecraft Dungeons II, in the library for every preset) reads numbers
off your game's picture as they change, for games that don't share their stats any other way.
Choose **Set up boxes**, then drag a box around each number on the still of your game: emeralds,
level, a timer. Uncbox reads the boxes once a second with Windows' own text recognition, and a
new number has to read the same twice before it shows, so one blurry frame doesn't flash a wrong
value. Boxes are a share of the picture, so they keep working if the window changes size.

**Screen triggers** are in the same panel: *when this appears on screen, do something*. Choose
**Set up screen triggers**, pick **Add from a recipe** (a death counter for Souls games, GTA or
any "Game Over"; a Nuzlocke "{name} fainted!" that marks the party member down), and check that
the box sits over the right part of the picture. Once a second, only while a game picture is up
and a trigger is on, Uncbox reads just those boxes and looks for the words (ignoring case and
small reading mistakes). A trigger fires once per sighting: the words must be gone for a few
seconds before it can fire again. Every firing shows an **Undo**, and **Test** reads once and
says what it saw.

### SMITE 2

With the SMITE 2 preset showing and a match on, Uncbox reads the game's log for your god, build and
both teams, and reads three screens off the game's picture with Windows' own text recognition,
once a second:

- **Hold Tab** and the **Scoreboard** panel shows everyone's god, level, K/D/A and gold. Your own
  K/D/A also goes into the **Match** panel.
- **Hold T** (the combat log) and the **Damage** panel shows damage dealt and taken, the abilities
  behind them, and the top cards.
- The top bar (match clock, team kills), your gold and your K/D/A beside the portrait are read
  all the time. The K/D/A strip is tiny, so a number only counts after it reads the same twice,
  and it never goes down. The Tab screen always wins over it.
- A kill banner in the upper middle adds a line to **Recent kills** under the Scoreboard.

Both panels are in the preset's **On screen** list, not on the board to start with. Reading only
runs while the match is on and Uncbox's page is visible (in the Uncbox app it also runs behind the
game), and the heavy part runs off the page's main thread. It is best effort: OCR sometimes drops
a number or garbles a name, which shows as a dash or is filled in from the team totals.

### Steam

The Steam panel reads the Steam app's own files on this PC: which game is running, your name and
picture, playtime, recent games and achievements. Nothing to sign in to. Games you no longer have
installed get their name from the Steam store.

### Clips

While your game is showing as a **Window** or **Capture card**, Uncbox keeps the last 60 seconds
of it. Press **=** (in the game, or anywhere) to save them as a clip: 1080p, 60 fps, H.264 High
profile at 30 Mbps, encoded on your graphics card. Clips go to `Videos\Uncbox`, and the newest
show under **Clips** in the sidebar, where clicking one plays it right in Uncbox.

- The key is read, not taken over: `=` still types in chat and other apps, and Shift+= (`+`)
  doesn't clip. Change it from **Key** in the sidebar, or switch instant replay off there.
- Clips have the same crop as the game window, so the WoW addon's strip and menu bars stay out.
- Video only, like the rest of Uncbox. Keeping the last minute takes about 225 MB of memory.
- `--clips=<folder>` saves them somewhere else.

**Vertical shorts.** Open a clip and press **Make vertical** to get a 9:16 frame over the video.
Drag it (or use the Frame slider) to choose what the short shows, pick Start and End or just
**Last 30 s** / **Last 15 s**, then **Save vertical**. Uncbox re-encodes it in the page with your
graphics card (1080x1920, 60 fps, about 12 Mbps) and saves it next to the other clips as
`Uncbox <date> vertical.mp4`. It needs Chrome or Edge, and takes a little while for a long clip.

**Send to Discord.** Under **Clips** in the sidebar, add a Discord webhook (in Discord: channel
settings, Integrations, Webhooks, Copy Webhook URL). Then **Send to Discord** appears in the clip
player and in the vertical editor. Discord takes about 10 MB, so a bigger clip is first re-encoded
as a smaller 720p, 30 fps copy sized for its length; trims under 30 seconds stay sharp. The webhook
is a secret: it is kept only on this PC, in `data/clips-discord.json`, never in the saved state,
and the page only ever shows its last four characters.

### Twitch chat

Type your channel name into the chat panel. It connects anonymously and read-only, so there's
nothing to log in to. Bots like Nightbot and StreamElements are hidden; turn them back on from
the chat panel's **⋯**.

### Twitch stream widget

The **Twitch stream** widget signs in to your own channel (chat above stays anonymous and
separate). One-time setup:

1. At [dev.twitch.tv/console](https://dev.twitch.tv/console) click **Register Your Application**.
   Any name; OAuth Redirect URL `http://localhost`; Category **Application Integration** (or
   Other); Client Type **Public**.
2. Create it, click **Manage**, and copy the **Client ID**.
3. In the widget (edit mode) paste the Client ID, click **Sign in**, then go to
   twitch.tv/activate and enter the code shown.

The client ID and tokens stay in `data/twitch.json` on your PC and never reach the browser. The
server only reads Twitch (every 30 seconds) while a Twitch widget is on screen. Stream mode shows
the numbers only; editing is in edit mode.

### Discord voice

The Discord panel shows who's in your voice channel and lights people up as they talk, with
mute and deafen in the preset's style. You can mute, deafen and leave from the panel, and pin
channels to join with one click. Audio still runs through the Discord app.

- **The built-in Uncbox app:** click **Connect Discord** and approve the prompt in Discord.
  Until Discord approves the app, only its listed App Testers can connect. See
  [docs/discord-rpc-approval.md](docs/discord-rpc-approval.md).
- **Your own app:** create a blank app at
  [discord.com/developers/applications](https://discord.com/developers/applications). Under
  OAuth2, turn on **Public Client** and add the redirect `http://localhost`, then paste its
  Application ID into the Discord panel. If the redirect is missing, the panel opens the right
  page and gives you the address to copy.

Sign-in uses PKCE, so no secret is needed or shipped. Tokens (and a secret, if you entered one)
stay in `data/discord.json` on your PC and never reach the browser.

### Driving it from another device

Every open copy stays in sync, so a phone can update counters while the captured window stays
clean. Uncbox only listens on your PC by default. To open it to your home network:

```powershell
$env:HOST = "0.0.0.0"; npm start
```

Then visit `http://<your-pc-ip>:5170`. There's no login, so only do this on a network you trust.
`--port=` and `--data=<folder>` change the port and where things are saved.

### Your data

Everything saves to `data/state.json` as you go, including presets of your own (see
[Sharing presets](#sharing-presets)). Saves from version 0.1 (PokéStream) move into the Pokémon
preset automatically.

## For developers

`npm run dev` runs with hot reload. Before a commit, `npm run check` runs the type check, a
syntax check of every server file, the tests and a production build.

```
server/index.mjs           static files, /api/state, live sync over /api/events
server/discord.mjs         Discord voice bridge over the local RPC pipe
server/open.mjs            opens setup pages in the default browser (fixed list only)
server/clips.mjs           saves and serves clips, sends them to Discord; server/hotkey.mjs watches the clip key
server/widgets.mjs         system load, now playing and notifications for the widgets
server/netstats.mjs        ping, jitter and loss, and a game's frame rate, for the Ping & FPS widget
server/twitch.mjs          Twitch sign-in and stream info for the Twitch widget
server/steam.mjs           the Steam panel, from the Steam app's files
server/gallery.mjs         the preset gallery: reads gallery/ from GitHub (or a folder), keeps the list; scripts/gallery.mjs checks it
server/ocr.mjs             Windows text recognition for the Stats panel
src/hud/                   the Stats panel's screen reader
src/smite/                 SMITE 2 screens: parsers, image recipes, the reader, its store
src/clips/                 instant replay: the encoder worker, its store, the clip keys
src/events.ts              the page's one live connection to /api/events
native/UncboxShell/        the Windows app, where the game can be played in its panel
                           (see native/README.md); src/native.ts is the page's side
src/widgets/               the widget library: everything that can sit on the board, one folder
                           each; registry.ts lists them all (see src/widgets/README.md)
src/presets.ts             presets: titles, default layouts, starting data
src/presetfile.ts          the .uncbox preset file: what is left out, reading and checking one
src/presetio.ts            downloading a preset, importing one, dropping one on the page
src/state/                 saved state, loading and migration, the save/sync hook;
                           state/presets.ts is built-in and custom presets side by side
src/components/            the board, the sidebar (with the widget library) and other shared parts
src/styles.css             theme tokens and all styling
```

### Add a widget

A widget is one folder in `src/widgets/` plus one line in `src/widgets/registry.ts`. The sidebar's
Get More Widgets, the command palette, the smoke and accessibility tests and state loading all
read the registry, so there is nothing else to wire up. `src/widgets/README.md` has the steps, an
example and how presets recommend widgets.

### Add a preset

1. Add an id to `PRESET_IDS` in `src/state/model.ts`.
2. Add its entry to `PRESETS` in `src/presets.ts`: name, one-line blurb, any renamed panel
   titles, a default layout, the widgets that layout uses and its starting data. Then add its id
   to `presets` in the widgets you want it to recommend.
3. Add a `.theme-<id>` block of color, font and radius tokens at the top of `src/styles.css`,
   and a `.preset-card--<id> strong` rule so its sidebar card previews the font and color.

Presets of your own (saved copies and imports) are built on one of these: their `base` decides
the theme, panel wording and anything game-specific. In code, get the showing preset from
`activePreset(state)` in `src/state/presets.ts` rather than `PRESETS[state.preset]`, and check
`base` (not `state.preset`) for anything that belongs to one game. A new preset gets sharing for
free; if it keeps something personal or tied to this PC in `PresetData`, add it to `forSharing`
in `src/presetfile.ts`.

## Support

Uncbox is free. If it makes your stream better, you can
[buy me a coffee](https://www.buymeacoffee.com/liefwarrior).

Made by [Liefwarrior](https://github.com/Liefwarrior). Third-party licenses are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); run `npm run notices` after changing
dependencies.
