import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Box, useVideo } from '../hud/reader';
import { useCover } from '../native';

export interface Mark extends Box {
  id: string;
  label: string;
}

interface Props {
  stream: MediaStream;
  title: string;
  /** The boxes already drawn. */
  marks: Mark[];
  selected: string | null;
  /** False when no more boxes can be added; dragging then does nothing. */
  canDraw: boolean;
  /** A new box was dragged on the picture. */
  onDraw: (box: Box) => void;
  /** More buttons beside "New picture" and "Done". */
  head?: ReactNode;
  onClose: () => void;
  /** The list beside the picture. */
  children: ReactNode;
}

/**
 * A still of the game to draw boxes on, with a list beside it. Shared by the Stats boxes and the
 * screen triggers: both are boxes over the same picture.
 */
export function RegionEditor({ stream, title, marks, selected, canDraw, onDraw, head, onClose, children }: Props) {
  useCover(true);
  const video = useVideo(stream);
  const [still, setStill] = useState('');
  const [drawing, setDrawing] = useState<{ from: [number, number]; box: Box } | null>(null);
  const picture = useRef<HTMLDivElement>(null);

  const snap = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    setStill(c.toDataURL('image/jpeg', 0.85));
  };
  // The first frame takes a moment to arrive.
  useEffect(() => {
    const t = setInterval(() => {
      if (video.current?.videoWidth) {
        snap();
        clearInterval(t);
      }
    }, 100);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const at = (e: PointerEvent): [number, number] => {
    const r = picture.current!.getBoundingClientRect();
    const clamp = (n: number) => Math.min(100, Math.max(0, n));
    return [clamp(((e.clientX - r.left) / r.width) * 100), clamp(((e.clientY - r.top) / r.height) * 100)];
  };
  const boxFrom = ([x1, y1]: [number, number], [x2, y2]: [number, number]): Box => ({
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  });

  return createPortal(
    <div className="hud-editor" role="dialog" aria-label={title}>
      <div className="hud-editor__box">
        <div className="hud-editor__head">
          <strong>{title}</strong>
          <span className="spacer" />
          {head}
          <button className="btn btn--small" onClick={snap}>
            New picture
          </button>
          <button className="btn btn--small btn--accent" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="hud-editor__main">
          <div
            ref={picture}
            className="hud-editor__picture"
            onPointerDown={(e) => {
              if (!canDraw) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = at(e);
              setDrawing({ from: p, box: boxFrom(p, p) });
            }}
            onPointerMove={(e) => drawing && setDrawing({ ...drawing, box: boxFrom(drawing.from, at(e)) })}
            onPointerUp={() => {
              if (!drawing) return;
              setDrawing(null);
              if (drawing.box.w < 0.5 || drawing.box.h < 0.5) return;
              onDraw(drawing.box);
            }}
          >
            {still ? <img src={still} alt="Your game" draggable={false} /> : <p className="muted">Waiting for the game picture…</p>}
            {marks.map((r) => (
              <div
                key={r.id}
                className={`hud-editor__mark ${selected === r.id ? 'is-selected' : ''}`}
                style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
              >
                <span>{r.label}</span>
              </div>
            ))}
            {drawing && (
              <div
                className="hud-editor__mark is-drawing"
                style={{ left: `${drawing.box.x}%`, top: `${drawing.box.y}%`, width: `${drawing.box.w}%`, height: `${drawing.box.h}%` }}
              />
            )}
          </div>
          <ol className="hud-editor__list">{children}</ol>
        </div>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}
