import { callOut } from '../callout';
import { useDiscord } from '../discord';
import { placePanel } from '../layout';
import type { AppState, BoardId } from '../state/model';
import { activePreset } from '../state/presets';
import type { MutatePreset } from '../state/useAppState';
import { normalizeChannel } from '../twitch';
import { showNotice } from '../undo';
import { addonLine, installWowAddon, seenLine, useNow, useWowRunning, useWowSeenAt, useWowStatus, windowLine } from '../wow';
import { Icon } from './Icon';
import { Section } from './Section';

interface Props {
  state: AppState;
  mutatePreset: MutatePreset;
}

/**
 * "Get set up": one line per panel on the board that still needs something from you. Clicking a
 * line points at that panel. Hiding a panel you don't use removes its line, and the whole list
 * goes away once everything is ready. It folds into a single "Get set up · 3 of 4" line: open
 * while nothing is done, folded once something is (unless you chose either way).
 */
export function SetupList({ state, mutatePreset }: Props) {
  const discord = useDiscord();
  const { base, data } = activePreset(state);
  const shown = new Set(data.layout.map((item) => item.i));
  const isWow = base === 'wow';
  const wow = useWowStatus(isWow);
  const seenAt = useWowSeenAt();
  const now = useNow();
  const running = useWowRunning(isWow && data.game.source === 'none', wow);

  // "always" lines show even when their panel is hidden; clicking one adds the panel back. "note"
  // is a line of plain words under it about where it stands.
  const steps: { key: string; id: BoardId; label: string; note?: string; done: boolean; always?: boolean }[] = [];
  if (isWow) {
    // WoW checks itself: Uncbox puts the addon in, reads the strip from the game, and picks the
    // game window once WoW runs.
    const addon = addonLine(wow);
    const seen = seenLine(seenAt, now);
    const window = windowLine(data.game.source !== 'none', running !== null);
    steps.push(
      { key: 'wow-window', id: 'game', label: 'Game window', note: window.note, done: window.done, always: true },
      { key: 'wow-addon', id: 'quests', label: 'Addon installed', note: addon.note, done: addon.done, always: true },
      { key: 'wow-seen', id: 'quests', label: 'Seen in game', note: seen.note, done: seen.done, always: true },
    );
  } else {
    steps.push({ key: 'game', id: 'game', label: 'Show your game', done: data.game.source !== 'none' });
  }
  steps.push(
    { key: 'camera', id: 'camera', label: 'Turn on your camera', done: state.camera.enabled },
    { key: 'chat', id: 'chat', label: 'Add your Twitch chat', done: normalizeChannel(state.twitch.channel) !== '' },
    { key: 'discord', id: 'discord', label: 'Connect Discord', done: discord.status === 'ready' },
  );
  const mine = steps.filter((s) => s.always || shown.has(s.id));
  const left = mine.filter((s) => !s.done).length;
  if (left === 0) return null;

  const go = (id: BoardId) => {
    if (!shown.has(id)) mutatePreset((d) => void d.layout.push(placePanel(d.layout, id)));
    callOut(id);
  };

  // The other WoW installs, if there are any the addon isn't in yet: one click to put it there too.
  const others = isWow ? (wow?.installs ?? []).filter((i) => i.version === null && i.path !== wow?.preferred) : [];
  const installIn = (path: string, label: string) =>
    installWowAddon(path)
      .then(() => showNotice(`Installed in ${label}. Type /reload in WoW.`))
      .catch((err) => showNotice(err instanceof Error ? err.message : 'Couldn’t install the addon.', true));

  return (
    <Section id="setup" title="Get set up" meta={`${mine.length - left} of ${mine.length}`} defaultOpen={left === mine.length}>
      <ol className="setup__steps">
        {mine.map((s) => (
          <li key={s.key}>
            <button className={`setup__step ${s.done ? 'is-done' : ''}`} onClick={() => go(s.id)}>
              <span className="setup__mark">{s.done && <Icon name="check" size={12} />}</span>
              <span className="setup__text">
                {s.label}
                {s.note && <small className="setup__note">{s.note}</small>}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {others.length > 0 && (
        <p className="setup__also">
          Also install in:{' '}
          {others.map((i) => (
            <button key={i.path} className="btn btn--small" onClick={() => void installIn(i.path, i.label)}>
              {i.label}
            </button>
          ))}
        </p>
      )}
      <p className="hint">Not using one? Take it off the board in On screen.</p>
    </Section>
  );
}
