import type { BodyProps, SettingsProps } from '../types';
import { useNow } from '../shared/useNow';
import type { CountdownSettings } from './settings';

export function CountdownBody({ settings: s }: BodyProps<CountdownSettings>) {
  const now = useNow(1000);
  const left = Math.max(0, s.target - now);
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor(left / 3_600_000) % 24;
  const m = Math.floor(left / 60_000) % 60;
  const sec = Math.floor(left / 1000) % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <div className="widget-countdown">
      <strong>{left === 0 ? 'Now!' : `${d > 0 ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(sec)}`}</strong>
      {s.text && <span>{s.text}</span>}
    </div>
  );
}

/** A Date as the value of an <input type="datetime-local">, in this PC's time. */
function toLocalInput(ms: number) {
  if (!ms) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function CountdownSettingsForm({ settings: s, set }: SettingsProps<CountdownSettings>) {
  return (
    <>
      <label>
        Until
        <input
          data-setup=""
          type="datetime-local"
          value={toLocalInput(s.target)}
          onChange={(e) => set({ target: e.target.value ? new Date(e.target.value).getTime() : 0 })}
        />
      </label>
      <label>
        What’s happening
        <input value={s.text} placeholder="Raid night" onChange={(e) => set({ text: e.target.value })} />
      </label>
    </>
  );
}
