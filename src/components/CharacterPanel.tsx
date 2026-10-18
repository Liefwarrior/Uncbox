import type { CSSProperties } from 'react';
import { WOW_CLASSES, WOW_RACES } from '../presets';
import type { CharacterState } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { useBoard } from './Board';
import { Icon } from './Icon';
import { Panel } from './Panel';

interface Props {
  character: CharacterState;
  title: string;
  mutatePreset: MutatePreset;
}

/** WoW character sheet: class-colored name, level and XP bars, zone, gold, hardcore flag. */
export function CharacterPanel({ character: c, title, mutatePreset }: Props) {
  const { editing } = useBoard();
  const set = (patch: Partial<CharacterState>) => mutatePreset((d) => void Object.assign(d.character, patch));
  const classColor = WOW_CLASSES[c.cls] ?? 'var(--text)';
  const capped = c.level >= c.maxLevel;
  const levelPct = Math.min(100, ((c.level - 1 + (capped ? 1 : c.xp / 100)) / Math.max(1, c.maxLevel - 1)) * 100);

  return (
    <Panel
      id="character"
      title={title}
      menu={[{ label: 'Hardcore (one life)', checked: c.hardcore, onSelect: () => set({ hardcore: !c.hardcore }) }]}
    >
      <div className="character" style={{ '--class': classColor } as CSSProperties}>
        <div className="character__head">
          <input
            className="ghost-input character__name"
            value={c.name}
            placeholder="Character name"
            onChange={(e) => set({ name: e.target.value })}
          />
          {c.hardcore && <span className="hc-badge">Hardcore</span>}
        </div>
        {editing ? (
          <div className="character__guild row">
            <input className="ghost-input" value={c.guild} placeholder="Guild" onChange={(e) => set({ guild: e.target.value })} />
            <input className="ghost-input" value={c.realm} placeholder="Realm" onChange={(e) => set({ realm: e.target.value })} />
          </div>
        ) : (
          (c.guild || c.realm) && (
            <p className="character__guild">
              {c.guild && <span>&lt;{c.guild}&gt;</span>}
              {c.realm && <span className="muted">{c.realm}</span>}
            </p>
          )
        )}

        <div className="character__line">
          <span className="character__level">
            <button className="icon-btn ctl" title="Level down" onClick={() => set({ level: Math.max(1, c.level - 1), xp: 0 })}>
              <Icon name="minus" size={12} />
            </button>
            <span>
              Level <strong key={c.level} className="bump">{c.level}</strong>
            </span>
            <button
              className="icon-btn ctl"
              title="Level up"
              onClick={() => set({ level: Math.min(c.maxLevel, c.level + 1), xp: 0 })}
            >
              <Icon name="plus" size={12} />
            </button>
          </span>
          {editing ? (
            <>
              <select value={c.race} onChange={(e) => set({ race: e.target.value })} title="Race">
                {WOW_RACES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <select value={c.cls} onChange={(e) => set({ cls: e.target.value })} title="Class">
                {Object.keys(WOW_CLASSES).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </>
          ) : (
            <span className="character__class">
              {c.race} <span style={{ color: classColor }}>{c.cls}</span>
            </span>
          )}
        </div>

        <div className="bar" title={`Level ${c.level} of ${c.maxLevel}`}>
          <div className="bar__fill bar__fill--level" style={{ width: `${levelPct}%` }} />
          <span className="bar__label">{capped ? `Level ${c.maxLevel}` : `${c.level} / ${c.maxLevel}`}</span>
        </div>
        {!capped && (
          <label className="bar bar--thin" title="Experience through this level">
            <div className="bar__fill bar__fill--xp" style={{ width: `${c.xp}%` }} />
            <span className="bar__label">XP {Math.round(c.xp)}%</span>
            {editing && (
              <input
                className="bar__input"
                type="range"
                min={0}
                max={100}
                value={c.xp}
                onChange={(e) => set({ xp: Number(e.target.value) })}
              />
            )}
          </label>
        )}

        <dl className="character__facts">
          <div>
            <dt>
              <Icon name="pin" size={13} />
            </dt>
            <dd>
              <input className="ghost-input" value={c.zone} placeholder="Zone" onChange={(e) => set({ zone: e.target.value })} />
            </dd>
          </div>
          <div>
            <dt>
              <span className="coin" />
            </dt>
            <dd>
              <input className="ghost-input" value={c.gold} placeholder="Gold" onChange={(e) => set({ gold: e.target.value })} />
            </dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}
