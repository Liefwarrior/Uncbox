import { showNotice } from '../undo';
import { DEFAULT_WOW_SETTINGS, saveWowSettings, useWowStatus, type WowModule, type WowSettings } from '../wow';

const MODULES: { id: WowModule; label: string; hint: string }[] = [
  { id: 'character', label: 'Your character', hint: 'Name, level, gold and zone' },
  { id: 'quests', label: 'Quest log', hint: 'Open quests and their goals' },
  { id: 'party', label: 'Party', hint: 'Who is in your group' },
  { id: 'guild', label: 'Guild', hint: 'Roster, who is online, guild news' },
  { id: 'raid', label: 'Raid', hint: 'The raid group, ready checks, bosses and who was there' },
  { id: 'loot', label: 'Loot', hint: 'Who got which item in a raid' },
];

const apply = (patch: Parameters<typeof saveWowSettings>[0]) =>
  saveWowSettings(patch)
    .then(() => showNotice('Saved. Type /reload in WoW to use it.'))
    .catch((err) => showNotice(err instanceof Error ? err.message : 'Couldn’t save that.', true));

/**
 * The sidebar's WoW addon section (WoW preset only): what the addon collects and where it draws its
 * strip. Uncbox writes these into the addon's settings file; WoW reads it on /reload, so nobody
 * edits Lua or types a slash command.
 */
export function WowSection() {
  const wow = useWowStatus(false);
  if (!wow) return null;
  const settings: WowSettings = { ...DEFAULT_WOW_SETTINGS, ...wow.settings };

  return (
    <>
      <ul className="toggles">
        <li>
          <label>
            <input type="checkbox" checked={wow.autoInstall} onChange={(e) => void apply({ autoInstall: e.target.checked })} />
            <span className="toggle" />
            <span className="toggles__text">
              Keep the addon installed
              <small>Uncbox installs and updates it in WoW by itself</small>
            </span>
          </label>
        </li>
        {MODULES.map((m) => (
          <li key={m.id}>
            <label>
              <input
                type="checkbox"
                checked={settings.modules[m.id]}
                onChange={(e) => void apply({ settings: { modules: { [m.id]: e.target.checked } } })}
              />
              <span className="toggle" />
              <span className="toggles__text">
                {m.label}
                <small>{m.hint}</small>
              </span>
            </label>
          </li>
        ))}
        <li>
          <label>
            <input type="checkbox" checked={settings.strip.enabled} onChange={(e) => void apply({ settings: { strip: { enabled: e.target.checked } } })} />
            <span className="toggle" />
            <span className="toggles__text">
              Send to the dashboard
              <small>Turn off and the dashboard stops updating from the game</small>
            </span>
          </label>
        </li>
      </ul>
      <label className="side-field">
        Where the strip sits
        <select value={settings.strip.corner} onChange={(e) => void apply({ settings: { strip: { corner: e.target.value as 'TOPLEFT' | 'TOPRIGHT' } } })}>
          <option value="TOPLEFT">Top left of the game</option>
          <option value="TOPRIGHT">Top right of the game</option>
        </select>
      </label>
      {wow.installs.length > 1 && (
        <label className="side-field">
          Use WoW from
          <select value={wow.flavor} onChange={(e) => void apply({ flavor: e.target.value })}>
            <option value="">Automatic ({wow.installs.find((i) => i.path === wow.preferred)?.label ?? 'best match'})</option>
            {wow.installs.map((i) => (
              <option key={i.path} value={i.path}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="hint">Changes reach WoW when you type /reload in it.</p>
    </>
  );
}
