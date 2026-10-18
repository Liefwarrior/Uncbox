import { type BoardId, isWindowId, type PanelId } from '../state/model';

// What every panel type is called, what it is for, and how big it starts. The sidebar, the board
// and state loading all read this, so a new panel type is added here and in ./index.tsx only.

export interface PanelInfo {
  /** Default title; a preset can rename it (SMITE calls the slots panel "Build"). */
  title: string;
  /** One plain line for the sidebar. */
  hint: string;
  /** Size when added to a layout that does not include it, and the smallest it can shrink to. */
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export const PANEL_INFO: Record<PanelId, PanelInfo> = {
  game: { title: 'Game', hint: 'Your game, big', w: 17, h: 17, minW: 6, minH: 6 },
  camera: { title: 'Camera', hint: 'Your webcam', w: 7, h: 7, minW: 3, minH: 3 },
  chat: { title: 'Chat', hint: 'Your Twitch chat', w: 7, h: 9, minW: 4, minH: 4 },
  slots: { title: 'Party', hint: 'Pictures with names', w: 7, h: 11, minW: 4, minH: 4 },
  run: { title: 'Run', hint: 'Title and a timer', w: 5, h: 6, minW: 4, minH: 4 },
  progress: { title: 'Progress', hint: 'Goals to tick off, and counters', w: 6, h: 7, minW: 4, minH: 4 },
  notes: { title: 'Notes', hint: 'A checklist', w: 6, h: 7, minW: 4, minH: 3 },
  match: { title: 'Match', hint: 'Kills, deaths and assists', w: 5, h: 7, minW: 4, minH: 6 },
  record: { title: 'Session', hint: 'Wins, losses and streak', w: 5, h: 7, minW: 4, minH: 5 },
  character: { title: 'Character', hint: 'Level, XP, zone and gold', w: 7, h: 8, minW: 5, minH: 6 },
  discord: { title: 'Discord', hint: 'Who is talking in voice', w: 4, h: 7, minW: 3, minH: 3 },
};

const WINDOW_SIZE = { w: 7, h: 8, minW: 3, minH: 3 };

export function sizeOf(id: BoardId) {
  return isWindowId(id) ? WINDOW_SIZE : PANEL_INFO[id];
}
