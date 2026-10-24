import { createContext, useContext } from 'react';
import type { BoardId } from '../state/model';

// What a panel can ask of the board it sits on. It lives apart from Board.tsx so that a widget
// can use it without importing the board, which imports the widget library.

export interface BoardApi {
  editing: boolean;
  /** Takes a panel off the board (a widget is deleted), with an Undo toast named after it. */
  hide: (id: BoardId, name?: string) => void;
  /** Resize a panel's width so its content area matches an aspect ratio (width / height). */
  fitWidthToAspect: (id: BoardId, aspect: number) => void;
  /** Arrow keys on a panel's handle: moves it a cell, or resizes it with Shift. False for any other key. */
  nudge: (id: BoardId, key: string, resize: boolean) => boolean;
}

export const BoardContext = createContext<BoardApi>({ editing: false, hide: () => {}, fitWidthToAspect: () => {}, nudge: () => false });
export const useBoard = () => useContext(BoardContext);
