export type DriveSettings = {
  /** Which list is showing: recent, starred, shared or search. */
  driveView: string;
};

export const defaultDriveSettings = (): DriveSettings => ({ driveView: 'recent' });

export function cleanDriveSettings(s: DriveSettings): DriveSettings {
  if (!['recent', 'starred', 'shared', 'search'].includes(s.driveView)) s.driveView = 'recent';
  return s;
}
