import type { BodyProps, SettingsProps } from '../types';
import { useNotifications } from './notifications';
import type { NotificationsSettings } from './settings';

export function NotificationsBody({ settings: s }: BodyProps<NotificationsSettings>) {
  const { toasts, error } = useNotifications(s.apps);
  if (error) return <p className="error">{error}</p>;
  if (!toasts.length) return <p className="muted">New notifications show up here.</p>;
  return (
    <ol className="widget-toasts">
      {toasts.map((t) => (
        <li key={t.id}>
          <span className="widget-toasts__app">{t.app}</span>
          <strong>{t.title}</strong>
          {s.showBody && t.body && <p>{t.body}</p>}
        </li>
      ))}
    </ol>
  );
}

export function NotificationsSettingsForm({ settings: s, set }: SettingsProps<NotificationsSettings>) {
  return (
    <>
      <label>
        Only from
        <input data-setup="" value={s.apps} placeholder="All apps (or e.g. Discord, Outlook)" onChange={(e) => set({ apps: e.target.value })} />
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.showBody} onChange={(e) => set({ showBody: e.target.checked })} /> Show the message,
        not just the title
      </label>
      <p className="hint">It’s on stream, so keep private apps out. Shown on this PC only.</p>
    </>
  );
}
