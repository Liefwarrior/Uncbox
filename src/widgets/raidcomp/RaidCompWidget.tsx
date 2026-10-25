import { useMemo } from 'react';
import { classLabel } from '../shared/classColor';
import { useNow } from '../shared/useNow';
import { ClassDot, ClassName, WowNotice } from '../shared/WowBits';
import { type GuildAnswer, longDate, type RaidAnswer, type RaidMember, type RaidSummary, useSetupNotice, useWowData } from '../shared/wowGuild';
import type { BodyProps } from '../types';
import { buffCoverage, bySubgroup, classTally, nextChoice, readySummary, ROLE_LABELS, ROLE_SHORT, type Role, roleCounts, roleOf, trouble, withChoice } from './comp';
import type { CompSettings } from './settings';

// Raid composition: the raid group in its 8 groups of 5, how many tanks, healers and damage
// dealers, which classes and buffs it has, who is offline or dead, and the last ready check. Out of
// a raid it shows the last raid instead. The game names the main tank; healers are a guess from the
// class, and clicking a role while editing sets it by hand (remembered in this widget's settings).

export function RaidCompBody({ settings: s, set, editing }: BodyProps<CompSettings>) {
  const raid = useWowData<RaidAnswer>('/api/wow/raid', ['raid', 'readychecks']);
  const inRaid = Boolean(raid.data?.inRaid);
  // Out of a raid, the last one (and the guild's classes to color its people with).
  const last = useWowData<{ raids: RaidSummary[] }>(raid.data && !inRaid ? '/api/wow/raids?limit=1' : null, ['raids']);
  const guild = useWowData<GuildAnswer>(raid.data && !inRaid ? '/api/wow/guild' : null, ['guild']);
  const now = useNow(30_000);
  const lastRaid = last.data?.raids[0] ?? null;
  const notice = useSetupNotice(inRaid || Boolean(lastRaid), raid.error || last.error);

  if (!raid.data && !raid.error) return editing ? <p className="muted">Looking for your raid…</p> : null;
  if (!raid.data) return notice ? <WowNotice notice={notice} quiet={!editing} icon="users" /> : null;
  if (!inRaid && !last.data && !last.error) return editing ? <p className="muted">Looking for your last raid…</p> : null;
  if (!inRaid) return <LastRaid raid={lastRaid} classes={guild.data?.members ?? []} notice={notice} editing={editing} />;
  return <Group data={raid.data} s={s} set={set} editing={editing} now={now} />;
}

function Group({ data, s, set, editing, now }: { data: RaidAnswer; s: CompSettings; set: BodyProps<CompSettings>['set']; editing: boolean; now: number }) {
  const members = data.members;
  const counts = useMemo(() => roleCounts(members, s.roles), [members, s.roles]);
  const groups = useMemo(() => bySubgroup(members), [members]);
  const tally = useMemo(() => classTally(members), [members]);
  const buffs = useMemo(() => buffCoverage(members), [members]);
  const away = useMemo(() => trouble(members), [members]);
  const ready = data.lastReadyCheck ? readySummary(data.lastReadyCheck, now) : null;

  const cycle = (m: RaidMember) => {
    const chosen = s.roles.find((c) => c.name === m.name)?.role ?? null;
    set({ roles: withChoice(s.roles, m.name, nextChoice(chosen)) });
  };

  return (
    <div className="wg-comp">
      <div className="wg-compact">
        <strong className="wg-compact__count">{members.length}</strong>
        <span className="wg-compact__label">
          in the raid · {counts.tank}T {counts.healer}H {counts.dps}D
        </span>
        {buffs.missing.length > 0 && <span className="wg-compact__warn">{buffs.missing.map((b) => `No ${b.cls}`).join(', ')}</span>}
      </div>
      <div className="wg-full">
        <header className="wg-head">
          <strong>{members.length} in the raid</strong>
          <span className="wg-roles">
            <span>{counts.tank} tank{counts.tank === 1 ? '' : 's'}</span>
            <span title={counts.guessed ? `${counts.guessed} of the healers are a guess from their class` : undefined}>
              {counts.healer} healer{counts.healer === 1 ? '' : 's'}
              {counts.guessed > 0 && ' (est.)'}
            </span>
            <span>{counts.dps} damage</span>
          </span>
        </header>

        <div className="wg-groups">
          {groups.map((g) => (
            <section key={g.group} className="wg-group" aria-label={`Group ${g.group}`}>
              <h4>Group {g.group}</h4>
              <ul>
                {Array.from({ length: Math.max(5, g.members.length) }, (_, i) => g.members[i]).map((m, i) =>
                  m ? <Member key={m.name} m={m} role={roleOf(m, s.roles)} editing={editing} onRole={() => cycle(m)} /> : <li key={`empty-${i}`} className="wg-slot muted" aria-hidden="true">–</li>,
                )}
              </ul>
            </section>
          ))}
        </div>

        <div className="wg-facts">
          <p className="wg-tally">
            {tally.map((t) => (
              <span key={t.cls} className="wg-tally__item">
                <ClassDot cls={t.cls} /> <span style={{ color: 'var(--text)' }}>{t.cls}</span> <strong>{t.n}</strong>
              </span>
            ))}
          </p>
          <p className={buffs.missing.length ? 'wg-warn' : 'muted'}>
            {buffs.missing.length ? buffs.missing.map((b) => `No ${b.cls} (${b.label})`).join(' · ') : 'Every class that brings a buff is here.'}
          </p>
          {(away.offline.length > 0 || away.dead.length > 0) && (
            <p className="wg-warn">
              {away.dead.length > 0 && <span>Dead: {away.dead.join(', ')}. </span>}
              {away.offline.length > 0 && <span>Offline: {away.offline.join(', ')}.</span>}
            </p>
          )}
          {ready ? (
            <p className={ready.notReady.length || ready.away.length ? 'wg-warn' : 'muted'}>
              Ready check {ready.when}: {ready.ready} ready
              {ready.notReady.length > 0 && ` · not ready: ${ready.notReady.join(', ')}`}
              {ready.away.length > 0 && ` · away: ${ready.away.join(', ')}`}
            </p>
          ) : (
            <p className="muted">No ready check yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Member({ m, role, editing, onRole }: { m: RaidMember; role: { role: Role; guessed: boolean }; editing: boolean; onRole: () => void }) {
  const mark = (
    <span className={`wg-role wg-role--${role.role} ${role.guessed ? 'is-guess' : ''}`} title={`${ROLE_LABELS[role.role]}${role.guessed ? ' (a guess from the class)' : ''}`}>
      {ROLE_SHORT[role.role]}
    </span>
  );
  return (
    <li className={`wg-member ${m.online ? '' : 'is-offline'} ${m.dead ? 'is-dead' : ''}`}>
      <ClassDot cls={m.class} hollow={!m.online} />
      <ClassName name={m.name} cls={m.class} className="wg-member__name" />
      {m.rank === 'leader' && <span className="wg-flag" title="Raid leader">L</span>}
      {m.rank === 'assist' && <span className="wg-flag" title="Assistant">A</span>}
      {m.masterLooter && <span className="wg-flag" title="Master looter">ML</span>}
      {m.dead && <span className="wg-badge wg-badge--dead">Dead</span>}
      {!m.online && <span className="wg-badge wg-badge--off">Offline</span>}
      {editing ? (
        <button type="button" className="wg-role-btn no-drag" onClick={onRole} aria-label={`${m.name}: ${ROLE_LABELS[role.role]}${role.guessed ? ' (guess)' : ''}. Change role`}>
          {mark}
        </button>
      ) : (
        mark
      )}
    </li>
  );
}

/** Not in a raid: the last one there was, and who came. */
function LastRaid({ raid, classes, notice, editing }: { raid: RaidSummary | null; classes: GuildAnswer['members']; notice: ReturnType<typeof useSetupNotice>; editing: boolean }) {
  const classOf = useMemo(() => new Map(classes.map((m) => [m.name, m.class])), [classes]);
  if (!raid) {
    if (notice) return <WowNotice notice={notice} quiet={!editing} icon="users" />;
    return editing ? <WowNotice notice={{ id: 'guild', title: 'Not in a raid', hint: 'When you are in a raid group, its 8 groups show up here.' }} /> : null;
  }
  const kills = raid.bosses.filter((b) => b.success);
  const there = raid.attendees.filter((a) => a.pct >= 50);
  return (
    <div className="wg-comp wg-comp--last">
      <header className="wg-head">
        <strong>Not in a raid</strong>
        <span className="muted">Last raid {longDate(raid.startedAt)}</span>
      </header>
      <p>
        <strong>{raid.zone || 'A raid'}</strong>
        <span className="muted">
          {' '}
          · {there.length} there · {kills.length} boss{kills.length === 1 ? '' : 'es'} down
        </span>
      </p>
      {kills.length > 0 && <p className="muted">{kills.map((b) => b.name).join(', ')}</p>}
      <ul className="wg-chips-list">
        {there.map((a) => (
          <li key={a.name} title={classLabel(classOf.get(a.name)) || undefined}>
            <ClassDot cls={classOf.get(a.name) ?? ''} /> <ClassName name={a.name} cls={classOf.get(a.name) ?? ''} />
          </li>
        ))}
      </ul>
    </div>
  );
}
