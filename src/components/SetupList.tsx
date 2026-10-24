import { callOut } from '../callout';
import { useDiscord } from '../discord';
import { placePanel } from '../layout';
import type { AppState, BoardId } from '../state/model';
import { activePreset } from '../state/presets';
import type { MutatePreset } from '../state/useAppState';
import { normalizeChannel } from '../twitch';
import { Icon } from './Icon';

interface Props {
  state: AppState;
  mutatePreset: MutatePreset;
}

/**
 * "Get set up": one line per panel on the board that still needs something from you. Clicking a
 * line points at that panel. Hiding a panel you don't use removes its line, and the whole list
 * goes away once everything is ready.
 */
export function SetupList({ state, mutatePreset }: Props) {
  const discord = useDiscord();
  const { base, data } = activePreset(state);
  const shown = new Set(data.layout.map((item) => item.i));

  // "always" lines show even when their panel is hidden; clicking one adds the panel back.
  const steps: { id: BoardId; label: string; done: boolean; always?: boolean }[] = [
    { id: 'game', label: 'Show your game', done: data.game.source !== 'none' },
    { id: 'camera', label: 'Turn on your camera', done: state.camera.enabled },
    { id: 'chat', label: 'Add your Twitch chat', done: normalizeChannel(state.twitch.channel) !== '' },
    { id: 'discord', label: 'Connect Discord', done: discord.status === 'ready' },
  ];
  if (base === 'wow') steps.push({ id: 'quests', label: 'Connect WoW', done: data.wowLinkAt > 0, always: true });
  const mine = steps.filter((s) => s.always || shown.has(s.id));
  const left = mine.filter((s) => !s.done).length;
  if (left === 0) return null;

  const go = (id: BoardId) => {
    if (!shown.has(id)) mutatePreset((d) => void d.layout.push(placePanel(d.layout, id)));
    callOut(id);
  };

  return (
    <section className="setup">
      <h3>
        Get set up <span className="setup__count">{mine.length - left} of {mine.length}</span>
      </h3>
      <ol className="setup__steps">
        {mine.map((s) => (
          <li key={s.id}>
            <button className={`setup__step ${s.done ? 'is-done' : ''}`} onClick={() => go(s.id)}>
              <span className="setup__mark">{s.done && <Icon name="check" size={12} />}</span>
              {s.label}
            </button>
          </li>
        ))}
      </ol>
      <p className="hint">Not using one? Turn it off below.</p>
    </section>
  );
}
