import { useEffect, useMemo, useRef, useState } from 'react';
import { qualityColor, QUALITIES } from '../shared/quality';
import { useNow } from '../shared/useNow';
import { WowNotice } from '../shared/WowBits';
import { type GuildEvent, type LootEntry, type RaidSummary, useSetupNotice, useWowData } from '../shared/wowGuild';
import type { BodyProps, SettingsProps } from '../types';
import { buildFeed, FEED_KINDS, type FeedItem, type FeedKind, KIND_LABELS, lineTime, newIds } from './feed';
import type { FeedSettings } from './settings';

// Guild news: joins, leaves, promotions, level-ups, boss kills and notable loot as a live feed.
// It stops moving while the mouse is over it (or a line has focus) so a line can be read, and on
// stream it drops the filter chips and fades new lines in. Who left or was demoted stays off
// stream unless "Show who left on stream" is on.

const SHOWN = 60;

export function FeedBody({ settings: s, set, editing }: BodyProps<FeedSettings>) {
  const events = useWowData<{ events: GuildEvent[] }>('/api/wow/guild/events?limit=120', ['events', 'guild']);
  const raids = useWowData<{ raids: RaidSummary[] }>(s.kinds.includes('boss') ? '/api/wow/raids?limit=10' : null, ['raids']);
  const loot = useWowData<{ loot: LootEntry[] }>(s.kinds.includes('loot') ? '/api/wow/loot?limit=60' : null, ['loot']);
  const now = useNow(30_000);
  const [paused, setPaused] = useState(false);
  const frozen = useRef<FeedItem[] | null>(null);
  const seen = useRef<Set<string> | null>(null);

  const live = useMemo(
    () =>
      buildFeed(
        { events: events.data?.events ?? [], raids: raids.data?.raids ?? [], loot: loot.data?.loot ?? [] },
        { kinds: s.kinds, lootMinQuality: s.lootMinQuality, hideDepartures: !editing && !s.showDeparturesOnStream, max: SHOWN },
      ),
    [events.data, raids.data, loot.data, s.kinds, s.lootMinQuality, s.showDeparturesOnStream, editing],
  );
  // While paused the lines on screen are the ones from when it paused.
  if (!paused) frozen.current = null;
  else frozen.current ??= live;
  const items = paused ? (frozen.current ?? live) : live;
  const waiting = paused ? live.filter((i) => !items.some((x) => x.id === i.id)).length : 0;

  // Lines that weren't there the last time we drew fade in; the first draw fades nothing.
  const fresh = useMemo(() => newIds(seen.current, items), [items]);
  useEffect(() => {
    if (events.data) seen.current = new Set(items.map((i) => i.id));
  }, [items, events.data]);

  const loaded = Boolean(events.data);
  const notice = useSetupNotice(loaded && items.length > 0, events.error);
  if (!loaded && !events.error) return editing ? <p className="muted">Waiting for guild news…</p> : null;

  const toggle = (k: FeedKind) => set({ kinds: s.kinds.includes(k) ? s.kinds.filter((x) => x !== k) : FEED_KINDS.filter((x) => x === k || s.kinds.includes(x)) });

  return (
    <div className="wg-feed" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      {editing && (
        <div className="wg-chips no-drag" role="group" aria-label="What to show">
          {FEED_KINDS.map((k) => (
            <button key={k} type="button" className={`wg-chip ${s.kinds.includes(k) ? 'on' : ''}`} aria-pressed={s.kinds.includes(k)} onClick={() => toggle(k)}>
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      )}
      {paused && (
        <p className="wg-paused muted" role="status">
          Paused while you read{waiting ? ` · ${waiting} new` : ''}
        </p>
      )}
      {items.length === 0 ? (
        notice ? (
          <WowNotice notice={notice} quiet={!editing} icon="newspaper" />
        ) : (
          <p className="muted">{s.kinds.length ? 'Nothing yet. News shows up here as it happens.' : 'Pick what to show above.'}</p>
        )
      ) : (
        <ol className="wg-news" aria-live="off">
          {items.map((i) => (
            <li key={i.id} className={`wg-news__item wg-news__item--${i.kind} ${fresh.has(i.id) ? 'is-new' : ''}`}>
              <time className="wg-news__time muted" dateTime={new Date(i.at).toISOString()}>
                {lineTime(i, now)}
              </time>
              <span className="wg-news__text" style={i.quality !== undefined ? { color: qualityColor(i.quality) } : undefined}>
                {i.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function FeedSettingsForm({ settings: s, set }: SettingsProps<FeedSettings>) {
  return (
    <>
      <label>
        Loot worth a line
        <select value={s.lootMinQuality} onChange={(e) => set({ lootMinQuality: Number(e.target.value) })}>
          {QUALITIES.filter((q) => q.id >= 2 && q.id <= 5).map((q) => (
            <option key={q.id} value={q.id}>
              {q.name} and better
            </option>
          ))}
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.showDeparturesOnStream} onChange={(e) => set({ showDeparturesOnStream: e.target.checked })} /> Show who left or was demoted on stream
      </label>
    </>
  );
}
