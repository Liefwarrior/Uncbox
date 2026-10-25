import type { Crop, VideoFit } from '../../state/model';

const FITS: VideoFit[] = ['contain', 'cover', 'stretch'];

export type WindowSettings = {
  fit: VideoFit;
  /** Percent of the window trimmed from each edge. */
  crop: Crop;
};

export const defaultWindowSettings = (): WindowSettings => ({ fit: 'contain', crop: { top: 0, right: 0, bottom: 0, left: 0 } });

export function cleanWindowSettings(s: WindowSettings): WindowSettings {
  if (!FITS.includes(s.fit)) s.fit = 'contain';
  return s;
}
