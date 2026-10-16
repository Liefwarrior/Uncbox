import { useEffect, useState } from 'react';
import type { AppState } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { Icon } from './Icon';
import { Panel } from './Panel';

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

export function RunPanel({ run, mutate }: { run: AppState['run']; mutate: Mutate }) {
  const { startedAt, elapsedMs } = run.timer;
  const running = startedAt !== null;
  const now = useNow(running);
  const elapsed = elapsedMs + (startedAt !== null ? Math.max(0, now - startedAt) : 0);

  const toggle = () =>
    mutate((s) => {
      const t = s.run.timer;
      if (t.startedAt === null) t.startedAt = Date.now();
      else {
        t.elapsedMs += Date.now() - t.startedAt;
        t.startedAt = null;
      }
    });
  const reset = () => {
    if (elapsed > 0 && !window.confirm('Reset the run timer to 0:00:00?')) return;
    mutate((s) => void (s.run.timer = { startedAt: null, elapsedMs: 0 }));
  };

  return (
    <Panel
      title="Run"
      className="panel--run"
      actions={
        <button className="icon-btn" title="Reset timer" onClick={reset}>
          <Icon name="reset" />
        </button>
      }
    >
      <input
        className="ghost-input run__title"
        value={run.title}
        placeholder="Game"
        onChange={(e) => mutate((s) => void (s.run.title = e.target.value))}
      />
      <input
        className="ghost-input run__subtitle"
        value={run.subtitle}
        placeholder="Challenge / category"
        onChange={(e) => mutate((s) => void (s.run.subtitle = e.target.value))}
      />
      <div className={`timer ${running ? 'is-running' : ''}`}>
        <span className="timer__digits">{formatDuration(elapsed)}</span>
        <button className="timer__btn ctl" title={running ? 'Pause' : 'Start'} onClick={toggle}>
          <Icon name={running ? 'pause' : 'play'} size={18} />
        </button>
      </div>
    </Panel>
  );
}
