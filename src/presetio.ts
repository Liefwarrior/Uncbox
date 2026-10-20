import { useEffect, useRef } from 'react';
import { fetchGalleryPreset, type GalleryEntry } from './gallery';
import { MAX_PRESET_FILE_BYTES, parsePresetText, PRESET_FILE_EXT, type PresetImportOk, presetFileName, toPresetFile } from './presetfile';
import { MAX_CUSTOM, type AppState, type PresetData, type PresetId } from './state/model';
import { addCustom, canAddCustom, installedFrom, newCustomId, takenNames, uniqueName } from './state/presets';
import type { Mutate } from './state/useAppState';
import { showNotice } from './undo';

// The browser side of sharing presets: saving a file, reading one, and noticing one dropped on
// the page. The file format and its cleaning are in presetfile.ts.

/** Saves a preset as "<name>.uncbox" through a normal download. */
export function downloadPreset(name: string, base: PresetId, data: PresetData) {
  const text = JSON.stringify(toPresetFile(name, base, data), null, 2);
  const fileName = presetFileName(name);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the download a moment to start before the file goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showNotice(`Saved “${fileName}” to your downloads.`);
}

/** Adds a preset file as a new preset of your own, and shows it. Says in plain words how it went. */
export async function importPresetFile(file: File, state: AppState, mutate: Mutate) {
  if (file.size > MAX_PRESET_FILE_BYTES) return showNotice('That file is too big to be a preset (the limit is 5 MB).');
  const text = await file.text().catch(() => null);
  if (text === null) return showNotice('Couldn’t read that file.');
  const result = parsePresetText(text);
  if (!result.ok) return showNotice(result.error);
  addImportedPreset(result, state, mutate);
}

export const FULL_MESSAGE = `You already have ${MAX_CUSTOM} presets of your own. Delete one to make room.`;

/**
 * Adds a checked preset (from a file or from the gallery) as a new preset of your own and shows it,
 * saying in plain words how it went. `galleryId` marks one that came from the gallery. False when
 * there was no room.
 */
export function addImportedPreset(result: PresetImportOk, state: AppState, mutate: Mutate, galleryId?: string): boolean {
  if (!canAddCustom(state)) {
    showNotice(FULL_MESSAGE);
    return false;
  }
  // Settled out here, not inside the recipe: the id must be the same whenever the recipe runs.
  const id = newCustomId();
  const name = uniqueName(result.name, takenNames(state));
  mutate((s) => addCustom(s, id, name, result.base, result.data, galleryId));
  showNotice(`Added “${name}” as a new preset. Your other presets are untouched.`);
  return true;
}

/**
 * Installs a gallery preset: fetches its file, checks it like any imported file, adds it and shows
 * it. One you already have is just shown. Says in plain words what went wrong; true when the preset
 * is now in your list. `fetchText` is only swapped out by the tests.
 */
export async function installGalleryPreset(
  entry: Pick<GalleryEntry, 'id' | 'name'>,
  state: AppState,
  mutate: Mutate,
  fetchText: (id: string) => Promise<string> = fetchGalleryPreset,
): Promise<boolean> {
  const have = installedFrom(state.custom, entry);
  if (have) {
    mutate((s) => void (s.preset = have.id));
    showNotice(`“${have.name}” is already installed. Showing it.`);
    return true;
  }
  if (!canAddCustom(state)) {
    showNotice(FULL_MESSAGE);
    return false;
  }
  let text: string;
  try {
    text = await fetchText(entry.id);
  } catch (err) {
    showNotice(err instanceof Error ? err.message : 'Couldn’t download that preset. Try again.');
    return false;
  }
  const result = parsePresetText(text);
  if (!result.ok) {
    showNotice(`Couldn’t install “${entry.name}”: ${result.error}`);
    return false;
  }
  return addImportedPreset(result, state, mutate, entry.id);
}

const isPresetFile = (f: File) => /\.(uncbox|json)$/i.test(f.name);

/** Dropping a preset file anywhere on the page imports it. */
export function usePresetDrop(state: AppState, mutate: Mutate) {
  const latest = useRef({ state, mutate });
  latest.current = { state, mutate };

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    // Without this the browser would open a dropped file in place of the dashboard. Places that
    // take drops themselves (a slot's picture) have already claimed the drag.
    const onOver = (e: DragEvent) => {
      if (hasFiles(e) && !e.defaultPrevented) e.preventDefault();
    };
    // Captured, so a preset file dropped on a slot or the game window is still a preset file.
    const onDropFirst = (e: DragEvent) => {
      const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.name.toLowerCase().endsWith(PRESET_FILE_EXT));
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void importPresetFile(file, latest.current.state, latest.current.mutate);
    };
    const onDropLast = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      const json = Array.from(e.dataTransfer?.files ?? []).find(isPresetFile);
      if (json) void importPresetFile(json, latest.current.state, latest.current.mutate);
      else showNotice(`Drop a ${PRESET_FILE_EXT} preset file here to add it.`);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDropFirst, true);
    window.addEventListener('drop', onDropLast);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDropFirst, true);
      window.removeEventListener('drop', onDropLast);
    };
  }, []);
}
