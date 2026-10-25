# Uncbox preset gallery

Presets other people made, for anyone to install from inside Uncbox: **Browse presets** in the
sidebar (or Ctrl K, then "Browse presets"). Uncbox reads this folder straight from GitHub, so there
is no server behind it. A preset shows up for everyone as soon as its pull request is merged.

## Share your own preset

1. In Uncbox, open the preset you want to share and choose **Export this preset**. You get a
   `.uncbox` file. (Uncbox leaves out your capture devices, game windows, progress and anything
   personal when it exports.)
2. Fork this repository and add your file as `gallery/presets/<id>.uncbox`. The id is lowercase
   letters, numbers and dashes, like `my-cozy-desk`.
3. Add an entry for it to `gallery/index.json`, in the `presets` list:

   ```json
   {
     "id": "my-cozy-desk",
     "name": "My cozy desk",
     "author": "your-name",
     "description": "One or two plain sentences about what it is for.",
     "base": "desk",
     "tags": ["desk", "relax"],
     "file": "presets/my-cozy-desk.uncbox",
     "preview": "",
     "updated": "2026-10-20"
   }
   ```

   - `name` must be the same as the name inside the file.
   - `base` is the built-in preset it is made from: `pokemon`, `smite2`, `wow`, `mcd2`, `steam`,
     `terminal` or `desk`. It must be the same as the file's.
   - `tags` are a few short lowercase words (up to 8) people can filter by.
   - `preview` is optional: a small picture at `previews/<id>.webp` (also `.png` or `.jpg`, under
     500 KB). Leave it `""` for none.
   - `updated` is the date, as `YYYY-MM-DD`.
4. Run `npm run check` (or just `node scripts/gallery.mjs`) to make sure the gallery still checks
   out, then open a pull request.

## The rules

- **No personal data.** No real names, character names, realms, guilds, places, addresses, links to
  your accounts, or pictures of you. Export from Uncbox so progress and devices are left out, and
  look through the file before you send it. The check refuses files that still carry progress.
- **Nothing over 1 MB** per preset. Slot pictures that travel inside the file are the usual reason
  a preset gets big; use fewer or smaller ones.
- **It must parse.** The file has to open in Uncbox as a normal preset, and the gallery check has
  to pass.
- Keep it kind and safe for everyone: nothing hateful, and nothing that tries to trick someone into
  anything.

By sending a preset in you agree that anyone may use, copy and change it.

## What is in this folder

- `index.json` lists every preset. Uncbox reads only what is listed.
- `presets/` holds the `.uncbox` files.
- `previews/` holds the optional pictures.
- The starter presets were made with `node scripts/gallery.mjs --write`.

To try the gallery from a copy on your PC before it is published, set `UNCBOX_GALLERY_URL` to the
folder (for example `C:\path\to\Uncbox\gallery`) or to another web address, and start Uncbox.
