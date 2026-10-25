import { usePrivacy } from '../privacy';
import { Icon } from './Icon';

/**
 * The "On air" switch, under the Stream mode button. On, personal info (mail, calendar, file
 * names, paths, addresses) is hidden even outside the stream mode view. It is also forced on while
 * OBS is streaming or recording, and the pill says so.
 */
export function OnAirToggle() {
  const { onAir, reason, setOnAir } = usePrivacy();
  const forced = reason === 'obs' || reason === 'stream';
  const on = reason !== null;
  const why = reason === 'obs' ? 'OBS is live, so it stays on' : reason === 'stream' ? 'Stream mode is on' : '';
  return (
    <button
      type="button"
      className={`onair ${on ? 'is-on' : ''}`}
      aria-pressed={on}
      aria-disabled={forced || undefined}
      title={forced ? `${why}.` : on ? 'Show personal info again' : 'Hide personal info (mail, calendar, files, paths) from the screen'}
      onClick={() => !forced && setOnAir(!onAir)}
    >
      <Icon name={on ? 'radio' : 'eyeOff'} size={14} />
      <span>{on ? 'On air: personal info hidden' : 'Off air'}</span>
      {forced && <small>{why}</small>}
    </button>
  );
}
