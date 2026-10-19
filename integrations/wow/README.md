# WoW live link

In the WoW Forever preset, the Character panel and the Quest log fill themselves in from the game.

WoW addons can't save files or go online while you play, so the Uncbox addon draws a thin strip
of colored blocks in the top-left corner of your screen. Uncbox already captures the WoW window
for the game panel, so it reads the strip from that video and crops it out. Viewers never see it.

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
- `/uncbox` hides or shows the strip. While it's hidden, the dashboard stops updating.
- The strip has to be visible on screen: keep other windows and addon frames off the top-left
  corner. Alt+Z doesn't hide it.
- Quests under a collapsed header in your quest log may be skipped.
- It works through a capture card too, as long as the picture isn't scaled down too far.

## What's in here

| File | What it does |
| --- | --- |
| `addon/Uncbox/` | The addon. `Codec.lua` turns text into blocks, `Uncbox.lua` collects the data and draws them. |
| `codec.ts` | The same codec in TypeScript, plus finding and reading the strip in a video frame. |
| `parse.ts` | Turns the addon's text into character and quest log data. |
| `useWowLink.ts` | Reads the game video about 10 times a second and updates the dashboard. |
| `install.mjs` | Finds WoW and installs the addon, for the Install addon button. |

Each page of the strip is 160 × 4 blocks of 3 × 3 pixels, so it's 480 × 12 pixels: a sync
pattern, then up to 229 bytes of text with a checksum. The addon shows about 8 pages a second.
