import { createContext, type CSSProperties, type ReactNode, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactGridLayout, { type Compactor, type EventCallback, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { fitResize, fitToBoard } from '../layout';
import { nudgeRect } from '../nudge';
import { sizeOf } from '../panels/catalog';
import { type AppWindow, type BoardId, GRID_COLS, GRID_ROWS, type GridItem, isWidgetId, isWindowId, type Widget } from '../state/model';
import { WIDGET_INFO } from '../widgets/catalog';
import type { MutatePreset } from '../state/useAppState';
import { offerUndo } from '../undo';

const MARGIN = 12;

interface BoardApi {
  editing: boolean;
  /** Hides a built-in panel or deletes an app window panel, with an Undo toast named after it. */
  hide: (id: BoardId, name?: string) => void;
  /** Resize a panel's width so its content area matches an aspect ratio (width / height). */
  fitWidthToAspect: (id: BoardId, aspect: number) => void;
  /** Arrow keys on a panel's handle: moves it a cell, or resizes it with Shift. False for any other key. */
  nudge: (id: BoardId, key: string, resize: boolean) => boolean;
}

const BoardContext = createContext<BoardApi>({ editing: false, hide: () => {}, fitWidthToAspect: () => {}, nudge: () => false });
export const useBoard = () => useContext(BoardContext);

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure now as well: ResizeObserver only reports on painted frames, so a window that loads
    // while covered or in the background would otherwise sit with an empty board.
    const r = el.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

const sameLayout = (a: GridItem[], b: readonly { i: string; x: number; y: number; w: number; h: number }[]) =>
  a.length === b.length &&
  a.every((item) => {
    const o = b.find((x) => x.i === item.i);
    return o && o.x === item.x && o.y === item.y && o.w === item.w && o.h === item.h;
  });

// The grid library types its items' ids as plain strings; ours are all board ids.
const asGrid = (layout: Layout) => layout as unknown as GridItem[];
const copyAll = (layout: GridItem[]) => layout.map((item) => ({ ...item }));
const sameIds = (a: GridItem[], b: GridItem[]) => a.length === b.length && a.every((item) => b.some((o) => o.i === item.i));

interface Props {
  layout: GridItem[];
  widgets: Widget[];
  editing: boolean;
  mutatePreset: MutatePreset;
  renderPanel: (id: BoardId) => ReactNode;
}

/**
 * The stage: a 24 × 24 grid stretched to fill the window, so a layout looks the same at any
 * resolution. Panels drag by their header and resize from the edges while editing.
 */
export function Board({ layout, widgets, editing, mutatePreset, renderPanel }: Props) {
  const { ref, w, h } = useElementSize<HTMLDivElement>();
  const rowHeight = Math.max(4, (h - MARGIN * (GRID_ROWS + 1)) / GRID_ROWS);
  const colWidth = Math.max(4, (w - MARGIN * (GRID_COLS + 1)) / GRID_COLS);

  const gridLayout = useMemo<Layout>(
    () => layout.map((item) => ({ ...item, minW: sizeOf(item.i, widgets).minW, minH: sizeOf(item.i, widgets).minH })),
    [layout],
  );

  // The grid library compacts after every move, resize and layout change. This stands in for its
  // vertical compactor so that nothing is ever pushed off the bottom of the board. The refs keep
  // the compactor itself stable across renders.
  const resizing = useRef<{ id: BoardId; start: GridItem[] } | null>(null);
  const dragging = useRef<BoardId | null>(null);
  const lastValid = useRef<GridItem[]>([]);
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const compactor = useMemo<Compactor>(
    () => ({
      type: 'vertical',
      allowOverlap: false,
      compact(layout) {
        const items = asGrid(layout);
        const run = resizing.current;
        let next: GridItem[] | null;
        if (run) {
          const wanted = items.find((item) => item.i === run.id);
          next = wanted ? copyAll(fitResize(run.start, run.id, wanted, widgetsRef.current)) : items;
          const fitted = wanted && next.find((item) => item.i === run.id);
          if (fitted) {
            // After compacting, the library puts a north-handle resize back at the y it asked for,
            // which would undo a capped or pushed resize. The fitted y is the only valid one.
            const { y } = fitted;
            Object.defineProperty(fitted, 'y', { get: () => y, set: () => {}, enumerable: true, configurable: true });
          }
        } else {
          next = fitToBoard(items, dragging.current ?? undefined, widgetsRef.current);
          // A drag that cannot fit even with everything shrunk just does not land.
          if (!next && sameIds(lastValid.current, items)) next = copyAll(lastValid.current);
        }
        if (!next) return layout;
        lastValid.current = copyAll(next);
        return next;
      },
    }),
    [],
  );

  const onResizeStart = useCallback<EventCallback>((layout, _old, item) => {
    if (item) resizing.current = { id: item.i as BoardId, start: copyAll(asGrid(layout)) };
  }, []);
  const onResizeStop = useCallback<EventCallback>(() => {
    // The library has just run its final compaction; later ones are ordinary.
    resizing.current = null;
  }, []);
  const onDragStart = useCallback<EventCallback>((_layout, _old, item) => {
    dragging.current = item ? (item.i as BoardId) : null;
  }, []);
  const onDragStop = useCallback<EventCallback>(() => {
    dragging.current = null;
  }, []);

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
      hide: (id, name) => {
        let item: GridItem | undefined;
        let win: AppWindow | undefined;
        let widget: Widget | undefined;
        mutatePreset((d) => {
          item = d.layout.find((it) => it.i === id) ?? item;
          win = d.windows.find((w) => w.id === id) ?? win;
          widget = d.widgets.find((w) => w.id === id) ?? widget;
          d.layout = d.layout.filter((it) => it.i !== id);
          if (isWindowId(id)) d.windows = d.windows.filter((w) => w.id !== id);
          if (isWidgetId(id)) d.widgets = d.widgets.filter((w) => w.id !== id);
        });
        const widgetName = widget && (widget.title || WIDGET_INFO[widget.type].name);
        offerUndo(`${name || win?.title || widgetName || 'Panel'} hidden`, () =>
          mutatePreset((d) => {
            if (win && !d.windows.some((w) => w.id === id)) d.windows.push(win);
            if (widget && !d.widgets.some((w) => w.id === id)) d.widgets.push(widget);
            if (item && !d.layout.some((it) => it.i === id)) d.layout.push(item);
          }),
        );
      },
      fitWidthToAspect: (id, aspect) =>
        mutatePreset((d) => {
          const item = d.layout.find((it) => it.i === id);
          if (!item || !Number.isFinite(aspect) || aspect <= 0) return;
          const pxHeight = item.h * rowHeight + (item.h - 1) * MARGIN;
          const cols = Math.round((pxHeight * aspect + MARGIN) / (colWidth + MARGIN));
          // Through the same fitting as a drag-resize, so neighbours give way and nothing leaves the board.
          d.layout = fitResize(d.layout, id, { x: item.x, y: item.y, w: cols, h: item.h }, d.widgets);
        }),
      nudge: (id, key, resize) => {
        const item = layout.find((it) => it.i === id);
        const want = item && nudgeRect(item, key, resize);
        if (!want) return false;
        // The same fitting as a mouse resize, so neighbours give way and nothing leaves the board.
        mutatePreset((d) => void (d.layout = fitResize(d.layout, id, want, d.widgets)));
        return true;
      },
    }),
    [editing, mutatePreset, rowHeight, colWidth, layout],
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
            resizeConfig={{ enabled: editing, handles: ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] }}
            compactor={compactor}
            onResizeStart={onResizeStart}
            onResizeStop={onResizeStop}
            onDragStart={onDragStart}
            onDragStop={onDragStop}
            onLayoutChange={onLayoutChange}
          >
            {layout.map((item, index) => (
              <div key={item.i} className="board__cell" data-panel={item.i}>
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
