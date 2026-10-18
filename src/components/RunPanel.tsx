import { useEffect, useState } from 'react';
import type { PresetData } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { Digits } from './Digits';
import { Icon } from './Icon';
import { Panel } from './Panel';

/** h:mm:ss, with a day count once a timer passes 24 hours (WoW /played gets there). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return d > 0 ? `${d}d ${String(h).padStart(2, '0')}:${clock}` : `${h}:${clock}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function RunPanel({ run, title, mutatePreset }: { run: PresetData['run']; title: string; mutatePreset: MutatePreset }) {
  const { startedAt, elapsedMs } = run.timer;
  const running = startedAt !== null;
  const now = useNow(running);
  const elapsed = elapsedMs + (startedAt !== null ? Math.max(0, now - startedAt) : 0);

  const toggle = () =>
    mutatePreset((d) => {
      const t = d.run.timer;
      if (t.startedAt === null) t.startedAt = Date.now();
      else {
        t.elapsedMs += Date.now() - t.startedAt;
        t.startedAt = null;
      }
    });

  return (
    <Panel
      id="run"
      title={title}
      menu={[
        {
          label: 'Reset timer',
          icon: 'reset',
          confirm: 'Click again to reset',
          onSelect: () => mutatePreset((d) => void (d.run.timer = { startedAt: null, elapsedMs: 0 })),
        },
      ]}
    >
      <div className="run">
        <input
          className="ghost-input run__title"
          value={run.title}
          placeholder="Game"
          onChange={(e) => mutatePreset((d) => void (d.run.title = e.target.value))}
        />
        <input
          className="ghost-input run__subtitle"
          value={run.subtitle}
          placeholder="Category"
          onChange={(e) => mutatePreset((d) => void (d.run.subtitle = e.target.value))}
        />
        <div className={`timer ${running ? 'is-running' : ''}`}>
          <span className="timer__dot" aria-hidden="true" />
          <Digits className="timer__digits" value={formatDuration(elapsed)} />
          <button className="timer__btn ctl" title={running ? 'Pause' : 'Start'} onClick={toggle}>
            <Icon name={running ? 'pause' : 'play'} size={18} />
          </button>
        </div>
      </div>
    </Panel>
  );
}
