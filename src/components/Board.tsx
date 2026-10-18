import { createContext, type CSSProperties, type ReactNode, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactGridLayout, { type Layout, verticalCompactor } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { sizeOf } from '../presets';
import { type BoardId, GRID_COLS, GRID_ROWS, type GridItem, isWindowId } from '../state/model';
import type { MutatePreset } from '../state/useAppState';

const MARGIN = 12;

interface BoardApi {
  editing: boolean;
  /** Hides a built-in panel; deletes an app window panel. */
  hide: (id: BoardId) => void;
  /** Resize a panel's width so its content area matches an aspect ratio (width / height). */
  fitWidthToAspect: (id: BoardId, aspect: number) => void;
}

const BoardContext = createContext<BoardApi>({ editing: false, hide: () => {}, fitWidthToAspect: () => {} });
export const useBoard = () => useContext(BoardContext);

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: GridItem) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Top-left-most free spot for a w × h panel, trying smaller sizes before giving up. */
export function placePanel(layout: GridItem[], id: BoardId): GridItem {
  const { w, h, minW, minH } = sizeOf(id);
  for (const [tw, th] of [
    [w, h],
    [Math.max(minW, Math.ceil(w / 2)), h],
    [w, Math.max(minH, Math.ceil(h / 2))],
    [minW, minH],
  ]) {
    for (let y = 0; y + th <= GRID_ROWS; y++) {
      for (let x = 0; x + tw <= GRID_COLS; x++) {
        const spot = { x, y, w: tw, h: th };
        if (!layout.some((item) => overlaps(spot, item))) return { i: id, ...spot };
      }
    }
  }
  // Board is full: drop it underneath and let the user make room.
  const bottom = layout.reduce((m, item) => Math.max(m, item.y + item.h), 0);
  return { i: id, x: 0, y: bottom, w, h };
}

const sameLayout = (a: GridItem[], b: readonly { i: string; x: number; y: number; w: number; h: number }[]) =>
  a.length === b.length &&
  a.every((item) => {
    const o = b.find((x) => x.i === item.i);
    return o && o.x === item.x && o.y === item.y && o.w === item.w && o.h === item.h;
  });

interface Props {
  layout: GridItem[];
  editing: boolean;
  mutatePreset: MutatePreset;
  renderPanel: (id: BoardId) => ReactNode;
}

/**
 * The stage: a 24 × 24 grid stretched to fill the window, so a layout looks the same at any
 * resolution. Panels drag by their header and resize from the edges while editing.
 */
export function Board({ layout, editing, mutatePreset, renderPanel }: Props) {
  const { ref, w, h } = useElementSize<HTMLDivElement>();
  const rowHeight = Math.max(4, (h - MARGIN * (GRID_ROWS + 1)) / GRID_ROWS);
  const colWidth = Math.max(4, (w - MARGIN * (GRID_COLS + 1)) / GRID_COLS);

  const gridLayout = useMemo<Layout>(
    () => layout.map((item) => ({ ...item, minW: sizeOf(item.i).minW, minH: sizeOf(item.i).minH })),
    [layout],
  );

  const onLayoutChange = useCallback(
    (next: Layout) => {
      if (sameLayout(layout, next)) return;
      mutatePreset((d) => {
        d.layout = next
          .filter((n) => d.layout.some((item) => item.i === n.i))
          .map(({ i, x, y, w, h }) => ({ i: i as BoardId, x, y, w, h }));
      });
    },
    [layout, mutatePreset],
  );

  const api = useMemo<BoardApi>(
    () => ({
      editing,
      hide: (id) =>
        mutatePreset((d) => {
          d.layout = d.layout.filter((item) => item.i !== id);
          if (isWindowId(id)) d.windows = d.windows.filter((w) => w.id !== id);
        }),
      fitWidthToAspect: (id, aspect) =>
        mutatePreset((d) => {
          const item = d.layout.find((it) => it.i === id);
          if (!item || !Number.isFinite(aspect) || aspect <= 0) return;
          const pxHeight = item.h * rowHeight + (item.h - 1) * MARGIN;
          const cols = Math.round((pxHeight * aspect + MARGIN) / (colWidth + MARGIN));
          item.w = Math.min(GRID_COLS - item.x, Math.max(sizeOf(id).minW, cols));
        }),
    }),
    [editing, mutatePreset, rowHeight, colWidth],
  );

  return (
    <BoardContext.Provider value={api}>
      <div ref={ref} className={`board ${editing ? 'is-editing' : ''}`}>
        {w > 0 && h > 0 && (
          <ReactGridLayout
            width={w}
            layout={gridLayout}
            gridConfig={{ cols: GRID_COLS, rowHeight, margin: [MARGIN, MARGIN], containerPadding: [MARGIN, MARGIN] }}
            dragConfig={{
              enabled: editing,
              handle: '.drag-handle',
              cancel: 'button, input, select, textarea, a, label, .no-drag',
            }}
            resizeConfig={{ enabled: editing, handles: ['se', 'e', 's'] }}
            compactor={verticalCompactor}
            onLayoutChange={onLayoutChange}
          >
            {layout.map((item, index) => (
              <div key={item.i} className="board__cell">
                <div className="board__inner" style={{ '--i': index } as CSSProperties}>
                  {renderPanel(item.i)}
                </div>
              </div>
            ))}
          </ReactGridLayout>
        )}
      </div>
    </BoardContext.Provider>
  );
}
