import { describe, expect, it, vi } from 'vitest';
import { PRESET_FILE_VERSION, type PresetImportOk, toPresetFile } from './presetfile';
import { addImportedPreset, FULL_MESSAGE, installGalleryPreset } from './presetio';
import { defaultPresetData, defaultState, hydrate } from './state/hydrate';
import { type AppState, MAX_CUSTOM } from './state/model';
import { addCustom, installedFrom, newCustomId } from './state/presets';
import type { Mutate } from './state/useAppState';
import { showNotice } from './undo';

vi.mock('./undo', () => ({ showNotice: vi.fn() }));

/** A state and a mutate that applies changes straight to it. */
function setup() {
  const state: AppState = defaultState();
  const mutate: Mutate = (recipe) => recipe(state);
  return { state, mutate };
}

const imported = (name = 'Cozy desk', base: PresetImportOk['base'] = 'desk'): PresetImportOk => ({ ok: true, name, base, data: defaultPresetData(base) });
const fileText = (name: string, base: PresetImportOk['base'] = 'desk') => JSON.stringify(toPresetFile(name, base, defaultPresetData(base)));
const fill = (state: AppState, n = MAX_CUSTOM) => {
  for (let i = state.custom.length; i < n; i++) addCustom(state, newCustomId(), `Filler ${i}`, 'terminal', defaultPresetData('terminal'));
};
/** The last thing the page said to the person. */
const notice = () => String(vi.mocked(showNotice).mock.lastCall?.[0] ?? '');

describe('addImportedPreset', () => {
  it('adds it as a preset of your own, shows it, and records the gallery id', () => {
    const { state, mutate } = setup();
    expect(addImportedPreset(imported(), state, mutate, 'cozy-desk')).toBe(true);
    expect(state.custom).toHaveLength(1);
    expect(state.custom[0]).toMatchObject({ name: 'Cozy desk', base: 'desk', galleryId: 'cozy-desk' });
    expect(state.preset).toBe(state.custom[0].id);
    expect(notice()).toContain('Added “Cozy desk”');
  });

  it('leaves the gallery id off for a file imported by hand', () => {
    const { state, mutate } = setup();
    addImportedPreset(imported(), state, mutate);
    expect('galleryId' in state.custom[0]).toBe(false);
  });

  it('gives a name that is taken another number', () => {
    const { state, mutate } = setup();
    addImportedPreset(imported('Desk'), state, mutate);
    expect(state.custom[0].name).toBe('Desk 2');
  });

  it('says plainly when there are already as many presets as allowed', () => {
    const { state, mutate } = setup();
    fill(state);
    const before = state.preset;
    expect(addImportedPreset(imported(), state, mutate, 'cozy-desk')).toBe(false);
    expect(state.custom).toHaveLength(MAX_CUSTOM);
    expect(state.preset).toBe(before);
    expect(notice()).toBe(FULL_MESSAGE);
    expect(FULL_MESSAGE).toContain(String(MAX_CUSTOM));
  });
});

describe('installGalleryPreset', () => {
  const entry = { id: 'cozy-desk', name: 'Cozy desk' };

  it('fetches, checks and adds it, remembering where it came from', async () => {
    const { state, mutate } = setup();
    const fetchText = vi.fn(async () => fileText('Cozy desk'));
    expect(await installGalleryPreset(entry, state, mutate, fetchText)).toBe(true);
    expect(fetchText).toHaveBeenCalledWith('cozy-desk');
    expect(state.custom).toHaveLength(1);
    expect(state.custom[0].galleryId).toBe('cozy-desk');
    expect(state.preset).toBe(state.custom[0].id);
  });

  it('says so, and adds nothing, when the file is not a preset', async () => {
    const { state, mutate } = setup();
    expect(await installGalleryPreset(entry, state, mutate, async () => '{"hello":1}')).toBe(false);
    expect(await installGalleryPreset(entry, state, mutate, async () => 'not json')).toBe(false);
    expect(await installGalleryPreset(entry, state, mutate, async () => JSON.stringify({ uncbox: 'preset', version: PRESET_FILE_VERSION + 1, data: {} }))).toBe(false);
    expect(state.custom).toHaveLength(0);
    expect(notice()).toContain('Couldn’t install “Cozy desk”');
  });

  it('shows the server’s words when the download fails', async () => {
    const { state, mutate } = setup();
    const ok = await installGalleryPreset(entry, state, mutate, async () => {
      throw new Error('Couldn’t reach the gallery. Check your internet connection.');
    });
    expect(ok).toBe(false);
    expect(notice()).toContain('Check your internet connection');
    expect(state.custom).toHaveLength(0);
  });

  it('stops at the limit before downloading anything', async () => {
    const { state, mutate } = setup();
    fill(state);
    const fetchText = vi.fn(async () => fileText('Cozy desk'));
    expect(await installGalleryPreset(entry, state, mutate, fetchText)).toBe(false);
    expect(fetchText).not.toHaveBeenCalled();
    expect(notice()).toBe(FULL_MESSAGE);
  });

  it('shows the copy you already have instead of adding another, by gallery id', async () => {
    const { state, mutate } = setup();
    const fetchText = vi.fn(async () => fileText('Cozy desk'));
    await installGalleryPreset(entry, state, mutate, fetchText);
    state.preset = 'desk';
    expect(await installGalleryPreset(entry, state, mutate, fetchText)).toBe(true);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(state.custom).toHaveLength(1);
    expect(state.preset).toBe(state.custom[0].id);
  });

  it('knows a copy by its name when it has no gallery id', async () => {
    const { state, mutate } = setup();
    addCustom(state, newCustomId(), 'Cozy Desk', 'desk', defaultPresetData('desk'));
    const fetchText = vi.fn(async () => fileText('Cozy desk'));
    expect(await installGalleryPreset(entry, state, mutate, fetchText)).toBe(true);
    expect(fetchText).not.toHaveBeenCalled();
    expect(state.custom).toHaveLength(1);
  });
});

describe('installedFrom', () => {
  it('matches by gallery id first, then by name for one without an id', () => {
    const { state } = setup();
    addCustom(state, newCustomId(), 'Renamed by me', 'desk', defaultPresetData('desk'), 'cozy-desk');
    addCustom(state, newCustomId(), 'Ranked grind', 'smite2', defaultPresetData('smite2'));
    expect(installedFrom(state.custom, { id: 'cozy-desk', name: 'Cozy desk' })?.name).toBe('Renamed by me');
    expect(installedFrom(state.custom, { id: 'ranked-grind', name: 'Ranked grind' })?.name).toBe('Ranked grind');
    expect(installedFrom(state.custom, { id: 'nuzlocke-run', name: 'Nuzlocke run' })).toBeUndefined();
  });

  it('does not take another gallery preset for a name match', () => {
    const { state } = setup();
    addCustom(state, newCustomId(), 'Cozy desk', 'desk', defaultPresetData('desk'), 'some-other-id');
    expect(installedFrom(state.custom, { id: 'cozy-desk', name: 'Cozy desk' })).toBeUndefined();
  });
});

describe('saved state', () => {
  it('keeps a preset’s gallery id, and drops one that is not a plain id', () => {
    const { state } = setup();
    addCustom(state, newCustomId(), 'A', 'desk', defaultPresetData('desk'), 'cozy-desk');
    addCustom(state, newCustomId(), 'B', 'desk', defaultPresetData('desk'));
    const saved = JSON.parse(JSON.stringify(state));
    saved.custom[1].galleryId = '../etc/passwd';
    const back = hydrate(saved);
    expect(back.custom[0].galleryId).toBe('cozy-desk');
    expect(back.custom[1].galleryId).toBeUndefined();
  });
});
