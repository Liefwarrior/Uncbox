import { Fragment, useEffect, useRef, useState } from 'react';
import { onAutomationEditor } from '../automations/editor';
import { canAddAutomation, GAME_PRESETS, newAutomation, presetName, SUGGESTIONS, thenText, WEEKDAYS, whenText } from '../automations/rules';
import { useObs } from '../obs';
import { PRESETS } from '../presets';
import {
  type AppState,
  type Automation,
  type AutomationThen,
  type AutomationWhen,
  MAX_AUTOMATION_STEPS,
  MAX_NOTE,
  PRESET_IDS,
} from '../state/model';
import type { Mutate } from '../state/useAppState';
import { offerUndo, showNotice } from '../undo';
import { Icon } from './Icon';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const WHEN_OPTIONS: { kind: AutomationWhen['kind']; label: string }[] = [
  { kind: 'gameStarts', label: 'A game starts' },
  { kind: 'gameStops', label: 'A game stops' },
  { kind: 'streamStarts', label: 'OBS starts streaming' },
  { kind: 'streamStops', label: 'OBS stops streaming' },
  { kind: 'recordStarts', label: 'OBS starts recording' },
  { kind: 'time', label: 'It’s a certain time' },
  { kind: 'focusStarts', label: 'A focus round starts' },
  { kind: 'breakStarts', label: 'A break starts' },
];

/** The steps one can pick; stream mode and recording are two choices each, so the picker needs no extra on/off. */
const THEN_OPTIONS = [
  { id: 'preset', label: 'Switch to a preset' },
  { id: 'streamOn', label: 'Turn stream mode on' },
  { id: 'streamOff', label: 'Turn stream mode off' },
  { id: 'scene', label: 'Switch OBS to a scene' },
  { id: 'recordOn', label: 'Start recording' },
  { id: 'recordOff', label: 'Stop recording' },
  { id: 'focus', label: 'Start a focus round' },
  { id: 'note', label: 'Show a note' },
] as const;
type ThenId = (typeof THEN_OPTIONS)[number]['id'];

const thenId = (t: AutomationThen): ThenId => {
  switch (t.kind) {
    case 'stream':
      return t.on ? 'streamOn' : 'streamOff';
    case 'record':
      return t.on ? 'recordOn' : 'recordOff';
    default:
      return t.kind;
  }
};

function thenFor(id: ThenId, scenes: string[], custom: AppState['custom'], before?: AutomationThen): AutomationThen {
  switch (id) {
    case 'preset':
      return { kind: 'preset', preset: before?.kind === 'preset' ? before.preset : (custom[0]?.id ?? PRESET_IDS[0]) };
    case 'streamOn':
      return { kind: 'stream', on: true };
    case 'streamOff':
      return { kind: 'stream', on: false };
    case 'scene':
      return { kind: 'scene', scene: scenes[0] ?? '' };
    case 'recordOn':
      return { kind: 'record', on: true };
    case 'recordOff':
      return { kind: 'record', on: false };
    case 'focus':
      return { kind: 'focus' };
    case 'note':
      return { kind: 'note', text: before?.kind === 'note' ? before.text : '' };
  }
}

function whenFor(kind: AutomationWhen['kind'], before: AutomationWhen): AutomationWhen {
  switch (kind) {
    case 'gameStarts':
    case 'gameStops':
      return { kind, game: before.kind === 'gameStarts' || before.kind === 'gameStops' ? before.game : 'any' };
    case 'time':
      return { kind, at: before.kind === 'time' ? before.at : '21:00', days: before.kind === 'time' ? before.days : [] };
    default:
      return { kind };
  }
}

/** Whether a draft can be saved: a note has words, a scene is chosen, a time is set. */
export function isComplete(a: Automation): boolean {
  if (a.then.length === 0) return false;
  if (a.when.kind === 'time' && !/^\d{2}:\d{2}$/.test(a.when.at)) return false;
  return a.then.every((t) => (t.kind === 'note' ? t.text.trim() !== '' : t.kind === 'scene' ? t.scene !== '' : true));
}

/** The sentence: "When SMITE 2 starts, switch to the SMITE 2 preset." with the parts that vary in bold. */
function Sentence({ rule, custom }: { rule: Automation; custom: AppState['custom'] }) {
  return (
    <>
      When <strong>{whenText(rule.when)}</strong>,{' '}
      {rule.then.map((t, i) => (
        <Fragment key={i}>
          {i > 0 && ', then '}
          <strong>{thenText(t, custom)}</strong>
        </Fragment>
      ))}
      .
    </>
  );
}

/** The sidebar's Automations section: the rules, and a small editor for adding or changing one. */
export function AutomationsSection({ state, mutate }: { state: AppState; mutate: Mutate }) {
  const [draft, setDraft] = useState<Automation | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const rules = state.automations;

  const startNew = () => {
    if (!canAddAutomation(state)) return showNotice('That’s as many automations as fit. Remove one to add another.');
    setDraft(newAutomation());
    root.current?.scrollIntoView({ block: 'nearest' });
  };
  const startNewRef = useRef(startNew);
  startNewRef.current = startNew;
  useEffect(() => onAutomationEditor(() => startNewRef.current()), []);

  const save = (rule: Automation) => {
    mutate((s) => {
      const i = s.automations.findIndex((r) => r.id === rule.id);
      if (i >= 0) s.automations[i] = rule;
      else s.automations.push(rule);
    });
    setDraft(null);
  };
  const remove = (rule: Automation) => {
    const index = rules.findIndex((r) => r.id === rule.id);
    mutate((s) => void (s.automations = s.automations.filter((r) => r.id !== rule.id)));
    if (draft?.id === rule.id) setDraft(null);
    offerUndo(
      'Removed the automation',
      () => mutate((s) => void (!s.automations.some((r) => r.id === rule.id) && s.automations.splice(Math.min(index, s.automations.length), 0, rule))),
      true,
    );
  };
  const suggest = (make: () => Automation[]) => {
    const added = make();
    if (!canAddAutomation(state, added.length)) return showNotice('That’s as many automations as fit. Remove one to add another.');
    mutate((s) => void s.automations.push(...added));
    showNotice(added.length === 1 ? 'Added an automation.' : `Added ${added.length} automations.`);
  };

  return (
    <div ref={root}>
      <h3>Automations</h3>
      {rules.length > 0 && (
        <ul className="toggles autos">
          {rules.map((rule) => (
            <li key={rule.id} className={`auto ${rule.enabled ? '' : 'is-off'}`}>
              <label title={rule.enabled ? 'On' : 'Off'}>
                <input
                  type="checkbox"
                  aria-label={`${rule.enabled ? 'Turn off' : 'Turn on'} this automation`}
                  checked={rule.enabled}
                  onChange={(e) =>
                    mutate((s) => {
                      const r = s.automations.find((x) => x.id === rule.id);
                      if (r) r.enabled = e.target.checked;
                    })
                  }
                />
                <span className="toggle" />
              </label>
              <p className="auto__text">
                {rule.name && <small className="auto__name">{rule.name}</small>}
                <Sentence rule={rule} custom={state.custom} />
              </p>
              <button className="icon-btn" title="Edit" aria-label="Edit this automation" onClick={() => setDraft(structuredClone(rule))}>
                <Icon name="pencil" size={14} />
              </button>
              <button className="icon-btn" title="Delete" aria-label="Delete this automation" onClick={() => remove(rule)}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {rules.length === 0 && !draft && (
        <>
          <p className="hint">Make Uncbox react: when something happens, do something.</p>
          <ul className="autos__suggest">
            {SUGGESTIONS.map((s) => (
              <li key={s.id}>
                <button className="side-link" onClick={() => suggest(s.make)}>
                  <Icon name="zap" /> {s.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {draft ? (
        <Editor key={draft.id} initial={draft} isNew={!rules.some((r) => r.id === draft.id)} state={state} onSave={save} onCancel={() => setDraft(null)} />
      ) : (
        <button className="side-link" onClick={startNew}>
          <Icon name="plus" /> Add an automation
        </button>
      )}
    </div>
  );
}

function Editor({
  initial,
  isNew,
  state,
  onSave,
  onCancel,
}: {
  initial: Automation;
  isNew: boolean;
  state: AppState;
  onSave: (rule: Automation) => void;
  onCancel: () => void;
}) {
  const [rule, setRule] = useState(initial);
  // Asking OBS what it has is what makes the server connect to it, so only while this is open.
  const obs = useObs(true);
  const connected = Boolean(obs?.connected);
  const scenes = obs?.connected ? obs.scenes : [];
  const { when } = rule;

  const setWhen = (w: AutomationWhen) => setRule((r) => ({ ...r, when: w }));
  const setStep = (i: number, t: AutomationThen) => setRule((r) => ({ ...r, then: r.then.map((x, j) => (j === i ? t : x)) }));
  const days = when.kind === 'time' ? (when.days.length ? when.days : [0, 1, 2, 3, 4, 5, 6]) : [];

  const toggleDay = (d: number) => {
    if (when.kind !== 'time') return;
    const on = days.includes(d);
    // At least one day stays picked.
    if (on && days.length === 1) return;
    const next = on ? days.filter((x) => x !== d) : [...days, d];
    setWhen({ ...when, days: next.length === 7 ? [] : next.sort((a, b) => a - b) });
  };

  return (
    <form
      className="auto-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (isComplete(rule)) onSave({ ...rule, name: rule.name.trim() });
      }}
    >
      <p className="auto-edit__sentence">
        <Sentence rule={rule} custom={state.custom} />
      </p>

      <label>
        When
        <select value={when.kind} onChange={(e) => setWhen(whenFor(e.target.value as AutomationWhen['kind'], when))}>
          {WHEN_OPTIONS.map((o) => (
            <option key={o.kind} value={o.kind}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {(when.kind === 'gameStarts' || when.kind === 'gameStops') && (
        <label>
          Which game
          <select value={when.game} onChange={(e) => setWhen({ ...when, game: e.target.value as typeof when.game })}>
            <option value="any">Any Steam game</option>
            {(when.game === 'any' || GAME_PRESETS.includes(when.game) ? GAME_PRESETS : [...GAME_PRESETS, when.game]).map((id) => (
              <option key={id} value={id}>
                {PRESETS[id].name}
              </option>
            ))}
          </select>
        </label>
      )}
      {when.kind === 'time' && (
        <>
          <label>
            At
            <input type="time" value={when.at} required onChange={(e) => setWhen({ ...when, at: e.target.value })} />
          </label>
          <div className="auto-edit__days" role="group" aria-label="Days">
            {WEEKDAYS.map((d) => (
              <button key={d} type="button" className={`auto-edit__day ${days.includes(d) ? 'on' : ''}`} aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}>
                {DAY_LABELS[d]}
              </button>
            ))}
          </div>
        </>
      )}

      {rule.then.map((step, i) => {
        const id = thenId(step);
        return (
          <div className="auto-edit__step" key={i}>
            <label>
              {i === 0 ? 'Then' : 'And then'}
              <span className="auto-edit__pick">
                <select
                  value={id}
                  onChange={(e) => setStep(i, thenFor(e.target.value as ThenId, scenes, state.custom, step))}
                >
                  {THEN_OPTIONS.filter((o) => o.id !== 'scene' || connected || id === 'scene').map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {rule.then.length > 1 && (
                  <button
                    type="button"
                    className="icon-btn"
                    title="Remove this step"
                    aria-label="Remove this step"
                    onClick={() => setRule((r) => ({ ...r, then: r.then.filter((_, j) => j !== i) }))}
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
              </span>
            </label>
            {step.kind === 'preset' && (
              <select aria-label="Which preset" value={step.preset} onChange={(e) => setStep(i, { kind: 'preset', preset: e.target.value as typeof step.preset })}>
                {PRESET_IDS.map((p) => (
                  <option key={p} value={p}>
                    {PRESETS[p].name}
                  </option>
                ))}
                {state.custom.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {!presetName(state.custom, step.preset) && <option value={step.preset}>(missing preset)</option>}
              </select>
            )}
            {step.kind === 'scene' && (
              <select aria-label="Which scene" value={step.scene} onChange={(e) => setStep(i, { kind: 'scene', scene: e.target.value })}>
                {[...new Set([...scenes, step.scene].filter(Boolean))].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            {step.kind === 'note' && (
              <input
                aria-label="What the note says"
                type="text"
                value={step.text}
                maxLength={MAX_NOTE}
                placeholder="What should it say?"
                onChange={(e) => setStep(i, { kind: 'note', text: e.target.value })}
              />
            )}
          </div>
        );
      })}
      {rule.then.length < MAX_AUTOMATION_STEPS && (
        <button
          type="button"
          className="side-link side-link--quiet"
          onClick={() => setRule((r) => ({ ...r, then: [...r.then, thenFor('preset', scenes, state.custom)] }))}
        >
          <Icon name="plus" /> Add another step
        </button>
      )}

      <label>
        Name <small className="muted">(optional)</small>
        <input type="text" value={rule.name} maxLength={60} onChange={(e) => setRule((r) => ({ ...r, name: e.target.value }))} />
      </label>

      <div className="auto-edit__buttons">
        <button type="submit" className="btn btn--small btn--accent" disabled={!isComplete(rule)}>
          <Icon name="check" size={14} /> {isNew ? 'Add' : 'Save'}
        </button>
        <button type="button" className="btn btn--small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
