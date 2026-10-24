import { useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { showNotice } from '../../undo';
import { csvDate, downloadCsv } from '../shared/csv';
import { QUALITIES } from '../shared/quality';
import { useNow } from '../shared/useNow';
import { ClassDot, ClassName, ItemLink, WowNotice } from '../shared/WowBits';
import { ago, type GuildAnswer, hiddenNames, type LootEntry, nameLabel, type RaidSummary, shortDate, useSetupNotice, useWowData } from '../shared/wowGuild';
import type { BodyProps, SettingsProps } from '../types';
import { DAY_CHOICES, fairness, filterLoot, lootCsv } from './loot';
import type { LootSettings } from './settings';

// Raid loot: what dropped and who got it, filtered by player, raid, quality and date, with each
// item opening its Wowhead page; and "Fair share", who has had the fewest drops lately. Export
// CSV saves the shown drops for a loot council. On stream names are hidden ("Member 1") unless
// "Show names on stream" is on, and the controls are gone.

const MAX_ROWS = 200;

export function LootBody({ settings: s, set, editing }: BodyProps<LootSettings>) {
  const loot = useWowData<{ loot: LootEntry[] }>('/api/wow/loot?limit=500', ['loot']);
  const raids = useWowData<{ raids: RaidSummary[] }>('/api/wow/raids?limit=30', ['raids']);
  const guild = useWowData<GuildAnswer>('/api/wow/guild', ['guild']);
  const now = useNow(60_000);
  const [member, setMember] = useState('');
  const [raid, setRaid] = useState(0);

  const all = loot.data?.loot ?? [];
  const shown = useMemo(() => filterLoot(all, { member, raid, minQuality: s.minQuality, days: s.days }, now), [all, member, raid, s.minQuality, s.days, now]);
  const fair = useMemo(() => fairness(all, raids.data?.raids ?? [], { minQuality: s.minQuality, days: s.days, now }), [all, raids.data, s.minQuality, s.days, now]);
  const classOf = useMemo(() => new Map((guild.data?.members ?? []).map((m) => [m.name, m.class])), [guild.data]);
  const showNames = editing || s.showNamesOnStream;
  const hidden = useMemo(() => (showNames ? null : hiddenNames([...shown.map((l) => l.who), ...fair.map((f) => f.name)])), [showNames, shown, fair]);

  const notice = useSetupNotice(all.length > 0, loot.error);
  if (!loot.data && !loot.error) return editing ? <p className="muted">Looking for loot…</p> : null;
  if (all.length === 0 && fair.length === 0) {
    if (notice) return <WowNotice notice={notice} quiet={!editing} icon="gem" />;
    return editing ? <WowNotice icon="gem" notice={{ id: 'guild', title: 'No loot yet', hint: 'Drops you see in a raid show up here as the addon records them.' }} /> : null;
  }

  const exportCsv = () => {
    downloadCsv(`raid-loot-${csvDate(Date.now())}.csv`, lootCsv(shown, raids.data?.raids ?? []));
    showNotice('Saved the loot sheet to your downloads.');
  };
  const zoneOf = (id: number | null) => raids.data?.raids.find((r) => r.id === id)?.zone ?? '';

  return (
    <div className="wg-loot">
      <header className="wg-head">
        {editing ? (
          <div className="seg no-drag" role="group" aria-label="View">
            <button type="button" className={s.view === 'history' ? 'on' : ''} aria-pressed={s.view === 'history'} onClick={() => set({ view: 'history' })}>
              Drops
            </button>
            <button type="button" className={s.view === 'fair' ? 'on' : ''} aria-pressed={s.view === 'fair'} onClick={() => set({ view: 'fair' })}>
              Fair share
            </button>
          </div>
        ) : (
          <strong>{s.view === 'fair' ? 'Fair share' : 'Recent drops'}</strong>
        )}
        {editing && s.view === 'history' && (
          <button type="button" className="btn btn--small no-drag wg-export" onClick={exportCsv}>
            <Icon name="download" size={13} /> Export CSV
          </button>
        )}
      </header>

      {editing && (
        <div className="wg-tools no-drag">
          {s.view === 'history' && (
            <>
              <input type="search" value={member} placeholder="Player" aria-label="Filter by player" onChange={(e) => setMember(e.target.value)} />
              <select value={raid} aria-label="Raid" onChange={(e) => setRaid(Number(e.target.value))}>
                <option value={0}>Every raid</option>
                {(raids.data?.raids ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.zone || 'Raid'} · {shortDate(r.startedAt)}
                  </option>
                ))}
              </select>
            </>
          )}
          <select value={s.minQuality} aria-label="Quality" onChange={(e) => set({ minQuality: Number(e.target.value) })}>
            {QUALITIES.filter((q) => q.id <= 5).map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}+
              </option>
            ))}
          </select>
          <select value={s.days} aria-label="Date" onChange={(e) => set({ days: Number(e.target.value) })}>
            {DAY_CHOICES.map((d) => (
              <option key={d.days} value={d.days}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {s.view === 'fair' ? (
        <>
          <p className="muted wg-hint">Fewest drops first{s.days ? ` in the last ${s.days} days` : ''}, counting {QUALITIES[s.minQuality]?.name.toLowerCase()} and better.</p>
          <div className="wg-scroll">
            <table className="wg-table">
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col" className="wg-num">
                    Drops
                  </th>
                  <th scope="col" className="wg-num">
                    Raids
                  </th>
                  <th scope="col">Last drop</th>
                </tr>
              </thead>
              <tbody>
                {fair.slice(0, MAX_ROWS).map((f) => (
                  <tr key={f.name}>
                    <th scope="row" className="wg-who">
                      <ClassDot cls={classOf.get(f.name) ?? ''} /> <ClassName name={nameLabel(f.name, hidden)} cls={classOf.get(f.name) ?? ''} />
                    </th>
                    <td className={`wg-num ${f.drops === 0 ? 'wg-zero' : ''}`}>{f.drops}</td>
                    <td className="wg-num">{f.raids}</td>
                    <td className="muted">{f.lastAt ? ago(f.lastAt, now) : 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : shown.length === 0 ? (
        <p className="muted">No drops match.</p>
      ) : (
        <>
          <p className="muted wg-hint">
            {shown.length} drop{shown.length === 1 ? '' : 's'}
          </p>
          <ul className="wg-loot-list">
            {shown.slice(0, MAX_ROWS).map((l) => (
              <li key={l.id}>
                <ItemLink itemId={l.itemId} name={l.name} quality={l.quality} />
                {l.count > 1 && <span className="muted"> ×{l.count}</span>}
                <span className="wg-loot__who">
                  <ClassName name={nameLabel(l.who, hidden)} cls={classOf.get(l.who) ?? ''} />
                </span>
                <span className="muted wg-loot__where">
                  {l.boss || zoneOf(l.raidId) || 'Loot'} · {ago(l.at, now)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function LootSettingsForm({ settings: s, set }: SettingsProps<LootSettings>) {
  return (
    <>
      <label className="inline">
        <input type="checkbox" checked={s.showNamesOnStream} onChange={(e) => set({ showNamesOnStream: e.target.checked })} /> Show names on stream
      </label>
      <p className="muted">Without that, viewers see “Member 1”, “Member 2”…</p>
    </>
  );
}
