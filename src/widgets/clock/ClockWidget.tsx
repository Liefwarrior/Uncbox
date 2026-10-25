import type { BodyProps, SettingsProps } from '../types';
import { useNow } from '../shared/useNow';
import type { ClockSettings } from './settings';

export function ClockBody({ settings: s }: BodyProps<ClockSettings>) {
  const now = useNow(s.seconds ? 1000 : 60_000);
  const zone = s.timeZone || undefined;
  let time: string;
  let date: string;
  try {
    time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: s.seconds ? '2-digit' : undefined, hour12: s.hour12, timeZone: zone }).format(now);
    date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: zone }).format(now);
  } catch {
    return <p className="muted">Unknown time zone: {s.timeZone}</p>;
  }
  return (
    <div className="widget-clock">
      <strong>{time}</strong>
      <span>
        {date}
        {zone && ` · ${zone.split('/').pop()!.replace(/_/g, ' ')}`}
      </span>
    </div>
  );
}

function zones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

export function ClockSettingsForm({ settings: s, set }: SettingsProps<ClockSettings>) {
  return (
    <>
      <label>
        Time zone
        <select data-setup="" value={s.timeZone} onChange={(e) => set({ timeZone: e.target.value })}>
          <option value="">This PC’s</option>
          {zones().map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.hour12} onChange={(e) => set({ hour12: e.target.checked })} /> 12-hour
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.seconds} onChange={(e) => set({ seconds: e.target.checked })} /> Seconds
      </label>
    </>
  );
}
