// The preset gallery in gallery/: checks every file, and with --write makes the starter presets.
//
//   node scripts/gallery.mjs           checks gallery/ (this is what `npm run check` runs)
//   node scripts/gallery.mjs --write   writes the starter presets and gallery/index.json, then checks
//
// A check means: index.json is well formed (no entry dropped, no repeated id), every listed file is
// there, under 1 MB and parses as an Uncbox preset, says the same name and base as the index, holds
// no personal data or progress, and has a board that fits. Files nobody lists are flagged too.
// The page code is TypeScript, so it is loaded through Vite's module loader (no server is started).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { MAX_PREVIEW_BYTES, MAX_PRESET_BYTES, validateIndex } from '../server/gallery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'gallery');
const write = process.argv.includes('--write');

const vite = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false } });
const load = (file) => vite.ssrLoadModule(`/src/${file}`);
const { toPresetFile, fromPresetFile, MAX_PRESET_FILE_BYTES } = await load('presetfile.ts');
const { defaultPresetData, hydratePreset } = await load('state/hydrate.ts');
const { forSharing } = await load('presetfile.ts');
const { newWidget, sizeOf } = await load('widgets/registry.ts');
const { GRID_COLS, GRID_ROWS, isWidgetId, PRESET_IDS } = await load('state/model.ts');

// ---- the starter presets ----

const UPDATED = '2026-10-20';

/** A widget of a kind in the widget library, with settings that don't depend on this PC (a 12 / 24 hour choice is made here). */
const widget = (id, kind, title = '', settings = {}) => {
  const w = newWidget(kind, { id, title, settings });
  if ('hour12' in w.settings && !('hour12' in settings)) w.settings.hour12 = true;
  return w;
};

/** Stable ids, so writing the files again gives the same files. */
function steadyIds(d, prefix) {
  d.slots = d.slots.map((s, i) => ({ ...s, id: `${prefix}-slot-${i + 1}` }));
  d.counters = d.counters.map((c, i) => ({ ...c, id: `${prefix}-counter-${i + 1}` }));
  d.milestones.items = d.milestones.items.map((m, i) => ({ ...m, id: `${prefix}-goal-${i + 1}` }));
  d.notes = d.notes.map((n, i) => ({ ...n, id: `${prefix}-note-${i + 1}` }));
  return d;
}
const goals = (names) => names.map((name) => ({ id: '', name, done: false }));
const counters = (labels) => labels.map((label) => ({ id: '', label, value: 0 }));
const notes = (texts) => texts.map((text) => ({ id: '', text, done: false }));
const slots = (n) => Array.from({ length: n }, () => ({ id: '', name: '', detail: '', image: '', down: false }));

const SEEDS = [
  {
    id: 'nuzlocke-run',
    name: 'Nuzlocke run',
    author: 'Uncbox',
    description: 'A ready Nuzlocke board: your party, deaths and resets, badges up to the Champion, and the usual rules in the notes.',
    base: 'pokemon',
    tags: ['nuzlocke', 'challenge', 'run'],
    make() {
      const d = defaultPresetData('pokemon');
      d.background = 'stars';
      d.run = { title: 'Nuzlocke run', subtitle: 'Faint means gone', timer: { startedAt: null, elapsedMs: 0 } };
      d.counters = counters(['Deaths', 'Resets', 'Routes cleared', 'Boxed']);
      d.milestones = { label: 'Badges and league', items: goals(['Gym 1', 'Gym 2', 'Gym 3', 'Gym 4', 'Gym 5', 'Gym 6', 'Gym 7', 'Gym 8', 'Elite Four', 'Champion']) };
      d.notes = notes([
        'One catch per route, the first encounter only',
        'Fainted means dead: box it for good',
        'Nickname every Pokémon',
        'Dupes clause: skip a species you already have',
        'Shiny clause: always catch a shiny',
      ]);
      d.slots = slots(6);
      d.widgets = [widget('wdg-nuzlocke-rules', 'text', 'The rules', { text: 'First encounter only. If it faints, it’s gone. Name everyone.' })];
      // The base board, with the rules card where Discord was.
      d.layout = [
        { i: 'game', x: 0, y: 0, w: 17, h: 17 },
        { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
        { i: 'slots', x: 17, y: 7, w: 7, h: 11 },
        { i: 'chat', x: 17, y: 18, w: 7, h: 6 },
        { i: 'run', x: 0, y: 17, w: 4, h: 7 },
        { i: 'progress', x: 4, y: 17, w: 5, h: 7 },
        { i: 'notes', x: 9, y: 17, w: 4, h: 7 },
        { i: 'wdg-nuzlocke-rules', x: 13, y: 17, w: 4, h: 7 },
      ];
      return d;
    },
  },
  {
    id: 'ranked-grind',
    name: 'Ranked grind',
    author: 'Uncbox',
    description: 'For a night of SMITE 2 ranked: match and teams on screen, your record, daily goals, and a focus timer so you remember to take breaks.',
    base: 'smite2',
    tags: ['ranked', 'moba', 'session'],
    make() {
      const d = defaultPresetData('smite2');
      d.background = 'shards';
      d.run = { title: 'Ranked grind', subtitle: 'Climb tonight', timer: { startedAt: null, elapsedMs: 0 } };
      d.match = { god: '', role: '', mode: 'Ranked Conquest', k: 0, d: 0, a: 0 };
      d.counters = counters(['Games today', 'Tilt breaks']);
      d.milestones = { label: 'Tonight', items: goals(['Warm up', 'Win 3 ranked games', 'Take a break after 2 losses', 'Review one death']) };
      d.notes = notes(['Ward before every objective', 'Check for anti-heal by second item', 'Mute and breathe if tilted']);
      d.slots = slots(6);
      d.widgets = [widget('wdg-grind-focus', 'focus', 'Break timer', { focusWork: 45, focusShort: 10, focusLong: 20, focusRounds: 3 })];
      d.layout = [
        { i: 'game', x: 0, y: 0, w: 17, h: 17 },
        { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
        { i: 'teams', x: 17, y: 7, w: 7, h: 6 },
        { i: 'chat', x: 17, y: 13, w: 7, h: 11 },
        { i: 'match', x: 0, y: 17, w: 5, h: 7 },
        { i: 'record', x: 5, y: 17, w: 4, h: 7 },
        { i: 'progress', x: 9, y: 17, w: 4, h: 7 },
        { i: 'wdg-grind-focus', x: 13, y: 17, w: 4, h: 7 },
      ];
      return d;
    },
  },
  {
    id: 'cozy-desk',
    name: 'Cozy desk',
    author: 'Uncbox',
    description: 'A calm desk for evenings: the time and weather, one thing for today, a focus timer, what is playing, and a little checklist.',
    base: 'desk',
    tags: ['desk', 'relax', 'focus', 'widgets'],
    make() {
      const d = defaultPresetData('desk');
      d.background = 'bubbles';
      d.run = { title: 'Cozy desk', subtitle: '', timer: { startedAt: null, elapsedMs: 0 } };
      d.counters = counters(['Cups of tea', 'Breaks']);
      d.milestones = { label: 'Today', items: goals(['Stretch', 'Drink some water', 'Tidy the desk', 'One deep-work block', 'Step outside']) };
      d.notes = notes(['Open a window', 'Snack within reach']);
      d.widgets = [
        widget('wdg-cozy-clock', 'clock'),
        widget('wdg-cozy-weather', 'weather'),
        widget('wdg-cozy-today', 'text', 'Today’s one thing', { text: 'Pick one thing. Do that first.' }),
        widget('wdg-cozy-focus', 'focus', '', { focusWork: 50, focusShort: 10, focusLong: 25, focusRounds: 3 }),
        widget('wdg-cozy-media', 'media'),
        widget('wdg-cozy-launcher', 'launcher'),
        widget('wdg-cozy-notifications', 'notifications'),
      ];
      d.layout = [
        { i: 'wdg-cozy-clock', x: 0, y: 0, w: 6, h: 5 },
        { i: 'wdg-cozy-weather', x: 6, y: 0, w: 6, h: 5 },
        { i: 'wdg-cozy-today', x: 12, y: 0, w: 6, h: 5 },
        { i: 'wdg-cozy-focus', x: 18, y: 0, w: 6, h: 9 },
        { i: 'wdg-cozy-media', x: 0, y: 5, w: 12, h: 4 },
        { i: 'wdg-cozy-launcher', x: 12, y: 5, w: 6, h: 4 },
        { i: 'progress', x: 0, y: 9, w: 8, h: 15 },
        { i: 'notes', x: 8, y: 9, w: 8, h: 15 },
        { i: 'wdg-cozy-notifications', x: 16, y: 9, w: 8, h: 15 },
      ];
      return d;
    },
  },
  {
    id: 'steam-couch',
    name: 'Steam couch',
    author: 'Uncbox',
    description: 'Controller in hand: any Steam game big on screen with what Steam says you are playing, plus ping and frame rate, now playing and quick launch buttons.',
    base: 'steam',
    tags: ['steam', 'couch', 'controller', 'widgets'],
    make() {
      const d = defaultPresetData('steam');
      d.background = 'waves';
      d.run = { title: 'Couch night', subtitle: 'Steam', timer: { startedAt: null, elapsedMs: 0 } };
      d.notes = notes(['Controller charged', 'Snacks and a drink']);
      d.widgets = [
        widget('wdg-couch-network', 'network'),
        widget('wdg-couch-media', 'media'),
        widget('wdg-couch-launcher', 'launcher', 'Quick launch'),
      ];
      d.layout = [
        { i: 'game', x: 0, y: 0, w: 17, h: 17 },
        { i: 'camera', x: 17, y: 0, w: 7, h: 6 },
        { i: 'steam', x: 17, y: 6, w: 7, h: 10 },
        { i: 'chat', x: 17, y: 16, w: 7, h: 8 },
        { i: 'run', x: 0, y: 17, w: 4, h: 7 },
        { i: 'wdg-couch-network', x: 4, y: 17, w: 4, h: 7 },
        { i: 'wdg-couch-media', x: 8, y: 17, w: 5, h: 7 },
        { i: 'wdg-couch-launcher', x: 13, y: 17, w: 4, h: 7 },
      ];
      return d;
    },
  },
];

// ---- checking ----

const problems = [];
const bad = (where, what) => problems.push(`${where}: ${what}`);

/** Panels inside the board, big enough, not on top of each other, and each widget on it exists. */
function checkLayout(where, data) {
  const cells = new Set();
  const ids = new Set();
  for (const item of data.layout) {
    if (ids.has(item.i)) bad(where, `${item.i} is on the board twice`);
    ids.add(item.i);
    const { minW, minH } = sizeOf(item.i, data.widgets);
    if (item.x < 0 || item.y < 0 || item.x + item.w > GRID_COLS || item.y + item.h > GRID_ROWS) bad(where, `${item.i} is off the board`);
    if (item.w < minW || item.h < minH) bad(where, `${item.i} is smaller than it can be`);
    for (let x = item.x; x < item.x + item.w; x++) {
      for (let y = item.y; y < item.y + item.h; y++) {
        if (cells.has(`${x},${y}`)) bad(where, `${item.i} overlaps another panel`);
        cells.add(`${x},${y}`);
      }
    }
    if (isWidgetId(item.i) && !data.widgets.some((w) => w.id === item.i)) bad(where, `${item.i} has no widget`);
  }
  for (const w of data.widgets) if (!ids.has(w.id)) bad(where, `widget ${w.id} is not on the board`);
}

async function checkGallery() {
  const indexFile = path.join(dir, 'index.json');
  if (!existsSync(indexFile)) return bad('gallery/index.json', 'is missing');
  let json;
  try {
    json = JSON.parse(await readFile(indexFile, 'utf8'));
  } catch (err) {
    return bad('gallery/index.json', `isn't valid JSON (${err.message})`);
  }
  let index;
  try {
    index = validateIndex(json);
  } catch (err) {
    return bad('gallery/index.json', err.message);
  }
  if (index.dropped > 0) bad('gallery/index.json', `${index.dropped} entr${index.dropped === 1 ? 'y is' : 'ies are'} not valid or repeat an id (needs id, name, author, a known base, and file "presets/<id>.uncbox")`);
  const raw = Array.isArray(json.presets) ? json.presets : [];
  if (raw.length !== index.presets.length + index.dropped) bad('gallery/index.json', 'could not be read');

  const listed = new Set();
  for (const entry of index.presets) {
    const where = `gallery/${entry.file}`;
    listed.add(entry.file);
    const file = path.join(dir, entry.file);
    if (!existsSync(file)) {
      bad(where, `is listed for "${entry.id}" but missing`);
      continue;
    }
    const size = statSync(file).size;
    if (size > MAX_PRESET_BYTES) bad(where, `is ${(size / 1024).toFixed(0)} KB; the limit is ${MAX_PRESET_BYTES / 1024} KB`);
    if (size > MAX_PRESET_FILE_BYTES) continue;
    const text = await readFile(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      bad(where, 'is not valid JSON');
      continue;
    }
    const result = fromPresetFile(parsed);
    if (!result.ok) {
      bad(where, result.error);
      continue;
    }
    if (result.base !== entry.base) bad(where, `is based on ${result.base}, but the index says ${entry.base}`);
    if (result.name !== entry.name) bad(where, `is named "${result.name}", but the index says "${entry.name}"`);
    // Nothing personal or from play: cleaning the file the way sharing does must change nothing.
    const hydrated = hydratePreset(result.base, parsed.data);
    if (!isDeepStrictEqual(hydrated, forSharing(hydrated, result.base))) bad(where, 'has personal data or progress in it (export it again from Uncbox)');
    checkLayout(where, result.data);
    if (entry.preview) {
      const picture = path.join(dir, entry.preview);
      if (!existsSync(picture)) bad(`gallery/${entry.preview}`, `is listed for "${entry.id}" but missing`);
      else if (statSync(picture).size > MAX_PREVIEW_BYTES) bad(`gallery/${entry.preview}`, `is over ${MAX_PREVIEW_BYTES / 1024} KB`);
    }
  }
  const presetsDir = path.join(dir, 'presets');
  if (existsSync(presetsDir)) {
    for (const f of readdirSync(presetsDir)) {
      if (f.endsWith('.uncbox') && !listed.has(`presets/${f}`)) bad(`gallery/presets/${f}`, 'is not listed in index.json');
    }
  }
  return index.presets.length;
}

// ---- writing the starter presets ----

async function writeSeeds() {
  await mkdir(path.join(dir, 'presets'), { recursive: true });
  const exportedAt = new Date(`${UPDATED}T00:00:00Z`);
  const presets = [];
  for (const seed of SEEDS) {
    if (!PRESET_IDS.includes(seed.base)) throw new Error(`${seed.id}: unknown base ${seed.base}`);
    const data = steadyIds(seed.make(), seed.id.split('-')[0]);
    const file = toPresetFile(seed.name, seed.base, data, exportedAt);
    await writeFile(path.join(dir, 'presets', `${seed.id}.uncbox`), `${JSON.stringify(file, null, 2)}\n`);
    presets.push({ id: seed.id, name: seed.name, author: seed.author, description: seed.description, base: seed.base, tags: seed.tags, file: `presets/${seed.id}.uncbox`, preview: '', updated: UPDATED });
  }
  await writeFile(path.join(dir, 'index.json'), `${JSON.stringify({ version: 1, presets }, null, 2)}\n`);
  console.log(`Gallery: wrote ${presets.length} starter presets`);
}

try {
  if (write) await writeSeeds();
  const count = await checkGallery();
  if (problems.length > 0) {
    console.error(`Gallery: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`Gallery: ${count} presets OK`);
  }
} finally {
  await vite.close();
}
