import { useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { usePrivate } from '../../privacy';
import { csvDate, downloadCsv } from '../shared/csv';
import { ClassDot, ClassName, WowNotice } from '../shared/WowBits';
import { type AttendanceAnswer, type GuildAnswer, hiddenNames, longDate, nameLabel, type RaidSummary, shortDate, useSetupNotice, useWowData } from '../shared/wowGuild';
import { showNotice } from '../../undo';
import type { BodyProps, SettingsProps } from '../types';
import { ATTENDANCE_SORTS, attendanceCsv, averagePct, buildMatrix, raidDetail, SORT_LABELS, shapeRows } from './matrix';
import { RAID_COUNTS, type AttendanceSettings } from './settings';

// Raid attendance: everyone against the last N raids, with the percentage, and a CSV for a loot
// council. On stream names are hidden ("Member 1") unless "Show names on stream" is on, and the
// controls and the export are gone.

export function AttendanceBody({ settings: s, set, editing }: BodyProps<AttendanceSettings>) {
  const raids = useWowData<{ raids: RaidSummary[] }>(`/api/wow/raids?limit=${Math.min(100, s.raids + 10)}`, ['raids']);
  const attendance = useWowData<AttendanceAnswer>(`/api/wow/attendance?last=${s.raids}`, ['raids', 'guild']);
  const guild = useWowData<GuildAnswer>('/api/wow/guild', ['guild']);
  const [picked, setPicked] = useState<number | null>(null);

  const matrix = useMemo(() => buildMatrix(raids.data?.raids ?? [], attendance.data?.members ?? [], s.raids), [raids.data, attendance.data, s.raids]);
  const rows = useMemo(() => shapeRows(matrix.rows, { rank: s.rank, guildOnly: s.guildOnly }, s.sort), [matrix, s.rank, s.guildOnly, s.sort]);
  const ranks = guild.data?.guild.ranks ?? [];
  const showNames = !usePrivate() || s.showNamesOnStream;
  const hidden = useMemo(() => (showNames ? null : hiddenNames(rows.map((r) => r.name))), [showNames, rows]);

  const hasData = matrix.raids.length > 0;
  const error = raids.error || attendance.error;
  const notice = useSetupNotice(hasData, error);
  if (!raids.data && !attendance.data && !error) return editing ? <p className="muted">Looking at your raids…</p> : null;
  if (!hasData) {
    if (notice) return <WowNotice notice={notice} quiet={!editing} icon="calendar" />;
    return editing ? <WowNotice icon="calendar" notice={{ id: 'guild', title: 'No raids yet', hint: 'Attendance is counted from raids you are in while the Uncbox addon is running.' }} /> : null;
  }

  const rankIndexes = [...new Set(matrix.rows.map((r) => r.rankIndex).filter((r): r is number => r !== null))].sort((a, b) => a - b);
  const exportCsv = () => {
    downloadCsv(`raid-attendance-${csvDate(Date.now())}.csv`, attendanceCsv(matrix, rows, ranks));
    showNotice('Saved the attendance sheet to your downloads.');
  };
  const detailIndex = picked === null ? -1 : matrix.raids.findIndex((r) => r.id === picked);
  const detail = detailIndex >= 0 ? raidDetail(matrix.raids[detailIndex], matrix.rows, detailIndex) : null;

  return (
    <div className="wg-attendance">
      <header className="wg-head">
        <strong>
          Last {matrix.raids.length} raid{matrix.raids.length === 1 ? '' : 's'}
        </strong>
        <span className="muted">average {averagePct(rows)}%</span>
        {editing && (
          <button type="button" className="btn btn--small no-drag wg-export" onClick={exportCsv}>
            <Icon name="download" size={13} /> Export CSV
          </button>
        )}
      </header>

      {editing && (
        <div className="wg-tools no-drag">
          <select value={s.sort} aria-label="Sort by" onChange={(e) => set({ sort: e.target.value as AttendanceSettings['sort'] })}>
            {ATTENDANCE_SORTS.map((k) => (
              <option key={k} value={k}>
                Sort: {SORT_LABELS[k]}
              </option>
            ))}
          </select>
          <select value={s.rank} aria-label="Rank" onChange={(e) => set({ rank: Number(e.target.value) })}>
            <option value={-1}>Any rank</option>
            {rankIndexes.map((i) => (
              <option key={i} value={i}>
                {ranks[i] || `Rank ${i + 1}`}
              </option>
            ))}
          </select>
          <select value={s.raids} aria-label="How many raids" onChange={(e) => set({ raids: Number(e.target.value) })}>
            {[...new Set<number>([...RAID_COUNTS, s.raids])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  Last {n} raids
                </option>
              ))}
          </select>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="muted">No one matches.</p>
      ) : (
        <div className="wg-scroll" role="region" aria-label="Attendance table" tabIndex={0}>
          <table className="wg-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col" className="wg-num">
                  %
                </th>
                {matrix.raids.map((r) => (
                  <th key={r.id} scope="col" className="wg-cell">
                    <button type="button" className={`wg-colhead ${picked === r.id ? 'on' : ''}`} onClick={() => setPicked(picked === r.id ? null : r.id)} aria-pressed={picked === r.id} aria-label={`${shortDate(r.startedAt)}, ${r.zone || 'raid'}: show details`} title={`${r.zone} · ${r.bosses.length} boss${r.bosses.length === 1 ? '' : 'es'}`}>
                      {shortDate(r.startedAt)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <th scope="row" className="wg-who">
                    <ClassDot cls={row.cls} /> <ClassName name={nameLabel(row.name, hidden)} cls={row.cls} />
                  </th>
                  <td className={`wg-num wg-pct ${row.pct >= 75 ? 'is-high' : row.pct < 50 ? 'is-low' : ''}`}>{row.pct}%</td>
                  {row.present.map((p, i) => (
                    <td key={matrix.raids[i].id} className={`wg-cell ${p ? 'is-yes' : 'is-no'}`}>
                      <span aria-hidden="true">{p ? '✓' : '✕'}</span>
                      <span className="wg-sr">{p ? 'Was there' : 'Missed it'}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <section className="wg-raid-detail" aria-label="Raid details">
          <h4>
            {detail.zone} · {longDate(detail.startedAt)}
          </h4>
          <p className="muted">
            {detail.there.length} there{detail.size ? ` (a ${detail.size}-player raid)` : ''} · {detail.bosses.length} boss{detail.bosses.length === 1 ? '' : 'es'} down
            {detail.bosses.length > 0 && `: ${detail.bosses.join(', ')}`}
          </p>
          {detail.missed.length > 0 && <p>Missed it: {detail.missed.map((n) => nameLabel(n, hidden)).join(', ')}</p>}
        </section>
      )}
    </div>
  );
}

export function AttendanceSettingsForm({ settings: s, set }: SettingsProps<AttendanceSettings>) {
  return (
    <>
      <label className="inline">
        <input type="checkbox" checked={s.guildOnly} onChange={(e) => set({ guildOnly: e.target.checked })} /> Guild members only (leave out pickups)
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.showNamesOnStream} onChange={(e) => set({ showNamesOnStream: e.target.checked })} /> Show names on stream
      </label>
      <p className="muted">Without that, viewers see “Member 1”, “Member 2”…</p>
    </>
  );
}
