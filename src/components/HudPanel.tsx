import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGameStream, useHudReader, useVideo } from '../hud/reader';
import { useCover } from '../native';
import { type HudRegion, MAX_HUD, uid } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { useBoard } from './Board';
import { Icon } from './Icon';
import { Panel } from './Panel';

interface Props {
  hud: HudRegion[];
  title: string;
  /** Names the preset suggests for boxes ("Emeralds", "Level"). */
  suggestions: string[];
  mutatePreset: MutatePreset;
}

/**
 * Stats read live off the game's screen: you draw boxes over numbers on the game picture
 * (emeralds, level, a timer) and they show here, updating as they change in the game.
 */
export function HudPanel({ hud, title, suggestions, mutatePreset }: Props) {
  const { editing } = useBoard();
  const stream = useGameStream();
  const [setup, setSetup] = useState(false);
  useHudReader(stream, hud, mutatePreset);

  return (
    <Panel
      id="hud"
      title={title}
      empty={hud.length === 0}
      menu={[{ label: 'Set up boxes', icon: 'scan', disabled: !stream, onSelect: () => setSetup(true) }]}
    >
      {hud.length > 0 ? (
        <ul className="hud-stats">
          {hud.map((r) => (
            <li key={r.id}>
              <span className="hud-stats__label">{r.label || 'Stat'}</span>
              <strong key={r.value} className="hud-stats__value bump">
                {r.value ? (r.numeric ? Number(r.value).toLocaleString() : r.value) : '—'}
              </strong>
            </li>
          ))}
        </ul>
      ) : editing ? (
        <div className="hud-empty ctl">
          <p className="muted">Draw boxes over numbers on your game’s screen, and they show here, live.</p>
          <button className="btn btn--accent" data-setup="" disabled={!stream} onClick={() => setSetup(true)}>
            <Icon name="scan" /> Set up boxes
          </button>
          {!stream && <p className="hint">Show your game first: a Window, a Capture card, or Play here with clips on.</p>}
        </div>
      ) : null}
      {setup && stream && (
        <HudEditor stream={stream} hud={hud} suggestions={suggestions} mutatePreset={mutatePreset} onClose={() => setSetup(false)} />
      )}
    </Panel>
  );
}

interface EditorProps {
  stream: MediaStream;
  hud: HudRegion[];
  suggestions: string[];
  mutatePreset: MutatePreset;
  onClose: () => void;
}

type Box = Pick<HudRegion, 'x' | 'y' | 'w' | 'h'>;

/** A still of the game to draw boxes on, with the boxes and their live readings beside it. */
function HudEditor({ stream, hud, suggestions, mutatePreset, onClose }: EditorProps) {
  useCover(true);
  const video = useVideo(stream);
  const [still, setStill] = useState('');
  const [drawing, setDrawing] = useState<{ from: [number, number]; box: Box } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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

  const edit = (id: string, patch: Partial<HudRegion>) =>
    mutatePreset((d) => {
      const r = d.hud.find((x) => x.id === id);
      if (r) Object.assign(r, patch, 'x' in patch || 'numeric' in patch ? { value: '', at: 0 } : {});
    });
  const unused = suggestions.filter((s) => !hud.some((r) => r.label === s));

  return createPortal(
    <div className="hud-editor" role="dialog" aria-label="Set up stat boxes">
      <div className="hud-editor__box">
        <div className="hud-editor__head">
          <strong>Draw a box around each number on your game’s screen</strong>
          <span className="spacer" />
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
              if (hud.length >= MAX_HUD) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = at(e);
              setDrawing({ from: p, box: boxFrom(p, p) });
            }}
            onPointerMove={(e) => drawing && setDrawing({ ...drawing, box: boxFrom(drawing.from, at(e)) })}
            onPointerUp={() => {
              if (!drawing) return;
              setDrawing(null);
              if (drawing.box.w < 0.5 || drawing.box.h < 0.5) return;
              const id = uid();
              const label = unused[0] ?? `Stat ${hud.length + 1}`;
              mutatePreset((d) => void d.hud.push({ id, label, ...drawing.box, numeric: true, value: '', at: 0 }));
              setSelected(id);
            }}
          >
            {still ? <img src={still} alt="Your game" draggable={false} /> : <p className="muted">Waiting for the game picture…</p>}
            {hud.map((r) => (
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
          <ol className="hud-editor__list">
            {hud.map((r) => (
              <li key={r.id} className={selected === r.id ? 'is-selected' : ''} onClick={() => setSelected(r.id)}>
                <input value={r.label} placeholder="Name" onChange={(e) => edit(r.id, { label: e.target.value })} />
                <label className="inline" title="Reads digits only, which is more reliable for counts">
                  <input type="checkbox" checked={r.numeric} onChange={(e) => edit(r.id, { numeric: e.target.checked })} /> Number
                </label>
                <span className="hud-editor__reading">{r.value || 'Reading…'}</span>
                <button
                  className="icon-btn"
                  title="Remove this box"
                  onClick={() => mutatePreset((d) => void (d.hud = d.hud.filter((x) => x.id !== r.id)))}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
            {hud.length === 0 && <li className="hud-editor__note muted">Drag on the picture to make a box.</li>}
            {unused.length > 0 && (
              <li className="hud-editor__note">
                <small>Ideas:</small> {unused.join(', ')}
              </li>
            )}
          </ol>
        </div>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}
