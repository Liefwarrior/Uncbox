import { Icon } from '../../components/Icon';
import { classLabel } from '../shared/classColor';
import { ClassDot, ClassName, ItemLink } from '../shared/WowBits';
import { ago, clockTime, lasted, longDate, type MemberDetail, useWowData } from '../shared/wowGuild';
import { presenceText, rankChangeText, sessionLength } from './roster';

// One member of the guild in detail: where they stand, when they play, and what they got.

interface Props {
  name: string;
  now: number;
  /** Ask for the officer note as well (only ever while editing). */
  officer: boolean;
  /** Which notes may be shown (see notesShown). */
  notes: { publicNote: boolean; officerNote: boolean };
  onBack: () => void;
}

export function MemberView({ name, now, officer, notes, onBack }: Props) {
  const { data, error } = useWowData<MemberDetail>(
    `/api/wow/guild/member?name=${encodeURIComponent(name)}${officer ? '&officer=1' : ''}`,
    ['guild', 'events', 'loot', 'raids'],
  );
  return (
    <div className="wg-detail">
      <button type="button" className="btn btn--small wg-back" onClick={onBack}>
        <Icon name="arrowLeft" size={13} /> Back to the roster
      </button>
      {!data ? (
        <p className="muted">{error === 'No such member' ? `${name} isn’t in the guild any more.` : error || 'Looking them up…'}</p>
      ) : (
        <Detail data={data} now={now} notes={notes} />
      )}
    </div>
  );
}

function Detail({ data, now, notes }: { data: MemberDetail; now: number; notes: Props['notes'] }) {
  const { member: m, rankHistory, sessions, loot, attendance } = data;
  const played = sessions.reduce((sum, s) => sum + sessionLength(s, now), 0);
  return (
    <>
      <header className="wg-detail__head">
        <ClassDot cls={m.class} hollow={!m.online} />
        <div>
          <h3>
            <ClassName name={m.name} cls={m.class} />
          </h3>
          <p className="muted">
            Level {m.level} {classLabel(m.class)} · {m.rank} · {presenceText(m, now)}
            {m.online && m.zone ? ` in ${m.zone}` : ''}
          </p>
        </div>
      </header>

      {notes.publicNote && m.note && (
        <section>
          <h4>Public note</h4>
          <p>{m.note}</p>
        </section>
      )}
      {notes.officerNote && m.officerNote && (
        <section>
          <h4>Officer note</h4>
          <p>{m.officerNote}</p>
        </section>
      )}

      <section>
        <h4>Raid attendance</h4>
        {attendance && attendance.raids > 0 ? (
          <p>
            <strong>{attendance.pct}%</strong> · {attendance.attended} of {attendance.raids} recent raids
            {attendance.bosses > 0 && <span className="muted"> · {attendance.bossesAttended} of {attendance.bosses} boss kills</span>}
          </p>
        ) : (
          <p className="muted">No raids recorded yet.</p>
        )}
      </section>

      <section>
        <h4>Rank history</h4>
        {rankHistory.length ? (
          <ul className="wg-lines">
            {rankHistory.map((h, i) => (
              <li key={`${h.at}-${i}`}>
                {rankChangeText(h)}
                <span className="muted">
                  {' '}
                  · {longDate(h.at)}
                  {h.by ? ` · by ${h.by}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No promotions or demotions seen. Joined {m.firstSeen ? ago(m.firstSeen, now) : 'a while ago'}.</p>
        )}
      </section>

      <section>
        <h4>Recent play</h4>
        {sessions.length ? (
          <>
            <ul className="wg-lines">
              {sessions.slice(0, 6).map((s) => (
                <li key={s.start}>
                  {clockTime(s.start, now)}
                  <span className="muted"> · {s.end === null ? 'online now' : lasted(sessionLength(s, now))}</span>
                </li>
              ))}
            </ul>
            <p className="muted">About {lasted(played)} over the last {sessions.length} sessions.</p>
          </>
        ) : (
          <p className="muted">No play sessions recorded yet.</p>
        )}
      </section>

      <section>
        <h4>Loot received</h4>
        {loot.length ? (
          <ul className="wg-lines">
            {loot.slice(0, 10).map((l) => (
              <li key={l.id}>
                <ItemLink itemId={l.itemId} name={l.name} quality={l.quality} />
                <span className="muted">
                  {l.count > 1 ? ` ×${l.count}` : ''}
                  {l.boss ? ` · ${l.boss}` : ''} · {longDate(l.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No drops yet.</p>
        )}
      </section>
    </>
  );
}
