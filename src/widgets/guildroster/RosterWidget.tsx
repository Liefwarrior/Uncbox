import { useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { CLASS_NAMES, classLabel } from '../shared/classColor';
import { useNow } from '../shared/useNow';
import { ClassDot, ClassName, WowNotice } from '../shared/WowBits';
import { type GuildAnswer, type GuildMember, useMemberRequests, useSetupNotice, useWowData } from '../shared/wowGuild';
import type { BodyProps, SettingsProps } from '../types';
import { MemberView } from './MemberView';
import { filterRoster, headerText, isFiltering, notesShown, onlineDots, presenceText, rankOptions, ROSTER_SORTS, type RosterFilter, SORT_LABELS, sortRoster, countText } from './roster';
import type { RosterSettings } from './settings';

// The Guild roster: who is online now, with their class, level, rank and zone; search, filters and
// sorting while editing; click a member for their story. Officer notes only appear while editing and
// only when the setting is on; on stream the controls are gone and notes follow "Show notes on stream".

/** Rows drawn at most; a bigger guild narrows the list with the search. */
const MAX_ROWS = 300;

export function RosterBody({ widget, settings: s, set, editing }: BodyProps<RosterSettings>) {
  const notes = notesShown({ editing, showOfficerNotes: s.showOfficerNotes, showNotesOnStream: s.showNotesOnStream });
  // Officer notes are only asked of the server while they may be shown.
  const officer = notes.officerNote;
  const { data, error } = useWowData<GuildAnswer>(`/api/wow/guild${officer ? '?officer=1' : ''}`, ['guild', 'events']);
  const now = useNow(60_000);
  const [search, setSearch] = useState('');
  const [moreFilters, setMoreFilters] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  useMemberRequests(widget.id, setPicked);

  const available = Boolean(data?.available);
  const notice = useSetupNotice(available, error, data ? false : undefined);

  const filter: RosterFilter = { search, onlineOnly: s.onlineOnly, rank: s.rank, cls: s.cls, minLevel: s.minLevel, maxLevel: s.maxLevel };
  const members = data?.members ?? [];
  const shown = useMemo(() => sortRoster(filterRoster(members, filter), s.sort), [members, search, s.onlineOnly, s.rank, s.cls, s.minLevel, s.maxLevel, s.sort]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data && !error) return editing ? <p className="muted">Looking for your guild…</p> : null;
  if (!data || !available) return notice ? <WowNotice notice={notice} quiet={!editing} /> : null;

  if (picked) return <MemberView name={picked} now={now} officer={officer} notes={notes} onBack={() => setPicked(null)} />;

  const online = members.filter((m) => m.online).length;
  const dots = onlineDots(members);
  const compact = (
    <div className="wg-compact">
      <strong className="wg-compact__count">{online}</strong>
      <span className="wg-compact__label">online of {members.length}</span>
      <span className="wg-dots" role="img" aria-label={`${online} online`}>
        {dots.map((c, i) => (
          <ClassDot key={i} cls={c} />
        ))}
      </span>
    </div>
  );
  if (s.compact) return <div className="wg-roster wg-roster--compact">{compact}</div>;

  const ranks = rankOptions(data.guild.ranks, members);
  const filtering = isFiltering(filter);
  return (
    <div className="wg-roster">
      {compact}
      <div className="wg-full">
        <header className="wg-head">
          <strong className="wg-count" aria-live="polite">
            {filtering ? headerText(members, shown) : countText(online, members.length)}
          </strong>
          {data.guild.name && <span className="muted wg-guild">&lt;{data.guild.name}&gt;</span>}
        </header>

        {editing && (
          <div className="wg-tools no-drag">
            <label className="wg-search">
              <Icon name="search" size={13} />
              <input type="search" value={search} placeholder="Find a member" aria-label="Find a member" onChange={(e) => setSearch(e.target.value)} />
            </label>
            <select value={s.sort} aria-label="Sort by" onChange={(e) => set({ sort: e.target.value as RosterSettings['sort'] })}>
              {ROSTER_SORTS.map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
            <button type="button" className={`btn btn--small ${filtering ? 'btn--on' : ''}`} aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)}>
              Filters{filtering ? ' •' : ''}
            </button>
            {moreFilters && (
              <div className="wg-filters">
                <label className="inline">
                  <input type="checkbox" checked={s.onlineOnly} onChange={(e) => set({ onlineOnly: e.target.checked })} /> Online only
                </label>
                <select value={s.rank} aria-label="Rank" onChange={(e) => set({ rank: Number(e.target.value) })}>
                  <option value={-1}>Any rank</option>
                  {ranks.map((r) => (
                    <option key={r.index} value={r.index}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <select value={s.cls} aria-label="Class" onChange={(e) => set({ cls: e.target.value })}>
                  <option value="">Any class</option>
                  {CLASS_NAMES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <label className="wg-levels">
                  Level
                  <input type="number" min={0} max={80} value={s.minLevel || ''} placeholder="from" aria-label="Lowest level" onChange={(e) => set({ minLevel: Number(e.target.value) || 0 })} />
                  <input type="number" min={0} max={80} value={s.maxLevel || ''} placeholder="to" aria-label="Highest level" onChange={(e) => set({ maxLevel: Number(e.target.value) || 0 })} />
                </label>
              </div>
            )}
          </div>
        )}

        {shown.length === 0 ? (
          <p className="muted">{filtering ? 'No one matches.' : 'No members yet.'}</p>
        ) : (
          <ul className="wg-list">
            {shown.slice(0, MAX_ROWS).map((m) => (
              <Row key={m.name} m={m} now={now} notes={notes} onPick={() => setPicked(m.name)} />
            ))}
          </ul>
        )}
        {shown.length > MAX_ROWS && <p className="muted wg-more">Showing the first {MAX_ROWS}. Search to narrow it down.</p>}
      </div>
    </div>
  );
}

function Row({ m, now, notes, onPick }: { m: GuildMember; now: number; notes: { publicNote: boolean; officerNote: boolean }; onPick: () => void }) {
  return (
    <li>
      <button type="button" className={`wg-row ${m.online ? 'is-online' : 'is-offline'}`} onClick={onPick} title={`${m.name}: ${classLabel(m.class)}, ${m.rank}`}>
        <ClassDot cls={m.class} hollow={!m.online} />
        <span className="wg-row__who">
          <ClassName name={m.name} cls={m.class} className="wg-row__name" />
          {m.status && <span className={`wg-badge wg-badge--${m.status}`}>{m.status === 'afk' ? 'AFK' : 'DND'}</span>}
        </span>
        <span className="wg-row__level">{m.level}</span>
        <span className="wg-row__rank muted">{m.rank}</span>
        <span className="wg-row__where muted">{m.online ? m.zone || presenceText(m, now) : presenceText(m, now)}</span>
        {notes.publicNote && m.note && <span className="wg-row__note muted">“{m.note}”</span>}
        {notes.officerNote && m.officerNote && <span className="wg-row__note wg-row__note--officer">Officer: “{m.officerNote}”</span>}
      </button>
    </li>
  );
}

export function RosterSettingsForm({ settings: s, set }: SettingsProps<RosterSettings>) {
  return (
    <>
      <label className="inline">
        <input type="checkbox" checked={s.compact} onChange={(e) => set({ compact: e.target.checked })} /> Compact: just the online count and class dots
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.showOfficerNotes} onChange={(e) => set({ showOfficerNotes: e.target.checked })} /> Show officer notes (never on stream)
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.showNotesOnStream} onChange={(e) => set({ showNotesOnStream: e.target.checked })} /> Show notes on stream
      </label>
    </>
  );
}
