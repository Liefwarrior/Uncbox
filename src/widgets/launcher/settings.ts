export type LauncherSettings = {
  /** The ids of the saved tiles it shows, in order. The tiles themselves live on this PC (server/launcher.mjs). */
  launcherTiles: string[];
};

export const defaultLauncherSettings = (): LauncherSettings => ({ launcherTiles: [] });

export function cleanLauncherSettings(s: LauncherSettings): LauncherSettings {
  s.launcherTiles = s.launcherTiles.filter((t) => typeof t === 'string');
  return s;
}
