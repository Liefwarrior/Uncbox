import type { BodyProps, SettingsProps } from '../types';
import type { TextSettings } from './settings';

export function TextBody({ settings: s }: BodyProps<TextSettings>) {
  return <p className="widget-text">{s.text}</p>;
}

export function TextSettingsForm({ settings: s, set }: SettingsProps<TextSettings>) {
  return (
    <label>
      Text
      <textarea data-setup="" rows={3} value={s.text} placeholder="Anything you like" onChange={(e) => set({ text: e.target.value })} />
    </label>
  );
}
