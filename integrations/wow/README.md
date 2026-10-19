# WoW live link

In the WoW Forever preset, the Character panel, the Quest log and the Party panel fill themselves
in from the game.

WoW addons can't save files or go online while you play: the only files they write are saved when
you log out or `/reload`, and there's no network or clipboard access. So the Uncbox addon draws a
thin strip of colored blocks, 512 × 4 pixels, along the top-left edge of your screen. Uncbox
already captures the WoW window for the game panel, so it reads the strip from that video and crops
it out. Viewers never see it.

The strip only shows while there's something to send: for a moment after your character, quest
log or party changes, and briefly once a minute so a dashboard opened later catches up.

## Set it up

1. In the WoW preset, click **Connect WoW** in the Get set up list, then **Install addon** in the
   Quest log. Uncbox finds WoW in the usual places and copies the addon in. If it can't find WoW,
   it opens the folder with the addon: copy `Uncbox` into WoW Forever's AddOns folder,
   `World of Warcraft\_classic_beta_\Interface\AddOns` during the beta.
2. Start WoW, or type `/reload` if it's open. If Uncbox shows as out of date in the AddOns list on
   the character screen, tick **Load out of date AddOns**.
3. Show WoW in the game panel as a **Window**.

Hardcore stays a manual switch in the Character panel's ⋯ menu.

## Good to know

- It's made for WoW Forever (Interface 16001) and also loads in Classic Era.
- `/uncbox` turns the strip off or on. While it's off, the dashboard stops updating.
  `/uncbox sync` sends everything right away.
- The strip has to be visible on screen when it shows: keep other windows and addon frames off the
  top-left edge. Alt+Z doesn't hide it.
- The Party panel lists you and up to four others (your raid group, in a raid), with level, class
  and who's dead or offline. You can still type into it by hand; the addon rewrites it when your
  group changes.
- Updating from an older version? Install the addon again and `/reload`: the strip's layout
  changed, so an old addon and a new Uncbox can't read each other.
- Quests under a collapsed header in your quest log may be skipped.
- It works through a capture card too, as long as the picture isn't scaled down too far.

## What's in here

| File | What it does |
| --- | --- |
| `addon/Uncbox/` | The addon. `Codec.lua` turns text into blocks, `Uncbox.lua` collects the data and draws them. |
| `codec.ts` | The same codec in TypeScript, plus finding and reading the strip in a video frame. |
| `parse.ts` | Turns the addon's text into character, quest log and party data. |
| `useWowLink.ts` | Reads every frame of the game video (up to 60 a second) and updates the dashboard. |
| `install.mjs` | Finds WoW and installs the addon, for the Install addon button. |

Each page of the strip is 256 × 2 blocks of 2 × 2 pixels, so it's 512 × 4 pixels: a sync
pattern, then up to 181 bytes of text with a checksum. While it shows, the addon draws 20 pages a
second and sends each change three times over, in case a captured frame misses a page.
