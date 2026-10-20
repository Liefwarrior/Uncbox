import { useState } from 'react';
import { type Box, readBoxes, useFiredCounts, useGameStream, useHudReader, useVideo } from '../hud/reader';
import { orderedRecipes, type RecipeId, recipeById, triggerFromRecipe } from '../hud/recipes';
import { describeTest, firedText, phraseProblem } from '../hud/triggers';
import { useNow } from '../smite/useNow';
import {
  emptyTrigger,
  type HudRegion,
  MAX_COOLDOWN,
  MAX_HUD,
  MAX_PHRASE,
  MAX_TRIGGERS,
  type PresetData,
  type ScreenTrigger,
  TRIGGER_ACTIONS,
  type TriggerAction,
  uid,
} from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { useBoard } from './Board';
import { Icon } from './Icon';
import { Panel } from './Panel';
import { RegionEditor } from './RegionEditor';

interface Props {
  data: PresetData;
  title: string;
  /** Names the preset suggests for boxes ("Emeralds", "Level"). */
  suggestions: string[];
  /** Screen trigger recipes the preset suggests, listed first. */
  recipes: RecipeId[];
  mutatePreset: MutatePreset;
}

/**
 * Stats read live off the game's screen: you draw boxes over numbers on the game picture
 * (emeralds, level, a timer) and they show here, updating as they change in the game. Screen
 * triggers sit here too: phrases to watch for ("YOU DIED") that count a death or mark a party
 * member down.
 */
export function HudPanel({ data, title, suggestions, recipes, mutatePreset }: Props) {
  const { hud, triggers } = data;
  const { editing } = useBoard();
  const stream = useGameStream();
  const [setup, setSetup] = useState<'boxes' | 'triggers' | null>(null);
  useHudReader(stream, hud, mutatePreset);

  return (
    <Panel
      id="hud"
      title={title}
      empty={hud.length === 0 && triggers.length === 0}
      menu={[
        { label: 'Set up boxes', icon: 'scan', disabled: !stream, onSelect: () => setSetup('boxes') },
        { label: 'Set up screen triggers', icon: 'bell', disabled: !stream, onSelect: () => setSetup('triggers') },
      ]}
    >
      {hud.length > 0 && (
        <ul className="hud-stats">
          {hud.map((r) => (
            <li key={r.id}>
              <span className="hud-stats__label">{r.label || 'Stat'}</span>
              <strong key={r.value} className="hud-stats__value bump">
                {r.value ? (r.numeric ? Number(r.value).toLocaleString() : r.value) : '—'}
              </strong>
            </li>
          ))}
        </ul>
      )}
      {triggers.length > 0 && <TriggerList data={data} stream={stream} mutatePreset={mutatePreset} onSetup={() => setSetup('triggers')} />}
      {hud.length === 0 && triggers.length === 0 && editing && (
        <div className="hud-empty ctl">
          <p className="muted">
            Draw boxes over numbers on your game’s screen, and they show here, live. Or add a screen trigger, to count deaths when “YOU DIED” shows up.
          </p>
          <div className="hud-empty__buttons">
            <button className="btn btn--accent" data-setup="" disabled={!stream} onClick={() => setSetup('boxes')}>
              <Icon name="scan" /> Set up boxes
            </button>
            <button className="btn" disabled={!stream} onClick={() => setSetup('triggers')}>
              <Icon name="bell" /> Screen triggers
            </button>
          </div>
          {!stream && <p className="hint">Show your game first: a Window, a Capture card, or Play here with clips on.</p>}
        </div>
      )}
      {setup === 'boxes' && stream && (
        <HudEditor stream={stream} hud={hud} suggestions={suggestions} mutatePreset={mutatePreset} onClose={() => setSetup(null)} />
      )}
      {setup === 'triggers' && stream && (
        <TriggerEditor stream={stream} data={data} recipes={recipes} mutatePreset={mutatePreset} onClose={() => setSetup(null)} />
      )}
    </Panel>
  );
}

// ---------- screen triggers in the panel ----------

interface ListProps {
  data: PresetData;
  stream: MediaStream | null;
  mutatePreset: MutatePreset;
  onSetup: () => void;
}

/** Each trigger: on or off, when it last fired, how many times this session, and a Test button. */
function TriggerList({ data, stream, mutatePreset, onSetup }: ListProps) {
  const video = useVideo(stream);
  const counts = useFiredCounts();
  const now = useNow(true);
  const [said, setSaid] = useState<Record<string, string>>({});

  const test = async (t: ScreenTrigger) => {
    const say = (text: string) => setSaid((s) => ({ ...s, [t.id]: text }));
    const v = video.current;
    if (!v?.videoWidth) return say('Waiting for the game picture. Show your game first.');
    say('Reading…');
    try {
      const texts = await readBoxes(v, [t], document.createElement('canvas'));
      say(texts ? describeTest(data, t, texts[0] ?? '') : 'Couldn’t read the screen. Reading needs Windows and the Uncbox app running.');
    } catch {
      say('Couldn’t read the screen. Reading needs Windows and the Uncbox app running.');
    }
  };

  return (
    <section className="triggers ctl" aria-label="Screen triggers">
      <h3 className="triggers__head">
        Screen triggers
        <button className="icon-btn" title="Set up screen triggers" disabled={!stream} onClick={onSetup}>
          <Icon name="pencil" size={13} />
        </button>
      </h3>
      <ul>
        {data.triggers.map((t) => (
          <li key={t.id} className={t.enabled ? '' : 'is-off'}>
            <label className="trigger__switch toggles" title={t.enabled ? 'Watching: click to turn off' : 'Off: click to turn on'}>
              <input
                type="checkbox"
                checked={t.enabled}
                aria-label={`${t.label || t.phrase || 'Trigger'} on or off`}
                onChange={(e) => mutatePreset((d) => void (d.triggers.find((x) => x.id === t.id)!.enabled = e.target.checked))}
              />
              <span className="toggle" />
            </label>
            <span className="trigger__what">
              <strong>{t.label || t.phrase || 'Trigger'}</strong>
              <small>
                {counts.get(t.id) ?? 0}× this session · last {firedText(t.at, now)}
              </small>
            </span>
            <button className="btn btn--small" disabled={!stream} onClick={() => void test(t)}>
              Test
            </button>
            {said[t.id] && <p className="trigger__said">{said[t.id]}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- the trigger editor ----------

const ACTION_NAMES: Record<TriggerAction['kind'], string> = {
  counter: 'Add 1 to a counter',
  slotDown: 'Mark a party member down',
  milestone: 'Tick the next milestone',
};

interface TriggerEditorProps {
  stream: MediaStream;
  data: PresetData;
  recipes: RecipeId[];
  mutatePreset: MutatePreset;
  onClose: () => void;
}

/** Draw a box, say what to look for in it, and what to do when it shows up. */
function TriggerEditor({ stream, data, recipes, mutatePreset, onClose }: TriggerEditorProps) {
  const { triggers, counters } = data;
  const [selected, setSelected] = useState<string | null>(triggers[0]?.id ?? null);
  // A trigger whose box is being drawn again: the next box dragged replaces its box.
  const [redraw, setRedraw] = useState<string | null>(null);
  const full = triggers.length >= MAX_TRIGGERS;

  const edit = (id: string, patch: Partial<ScreenTrigger>) =>
    mutatePreset((d) => {
      const t = d.triggers.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });

  const addRecipe = (id: RecipeId) => {
    if (full) return;
    const { trigger, newCounter } = triggerFromRecipe(recipeById(id), counters);
    mutatePreset((d) => {
      if (newCounter) d.counters.push(newCounter);
      d.triggers.push(trigger);
    });
    setSelected(trigger.id);
  };

  const onDraw = (box: Box) => {
    if (redraw) {
      edit(redraw, box);
      setRedraw(null);
      return;
    }
    const t = { ...emptyTrigger(), ...box, label: `Trigger ${triggers.length + 1}`, action: { kind: 'counter' as const, counterId: counters[0]?.id ?? '' } };
    mutatePreset((d) => void d.triggers.push(t));
    setSelected(t.id);
  };

  return (
    <RegionEditor
      stream={stream}
      title={redraw ? 'Drag a new box where the words show up' : 'Screen triggers: drag on the picture to add one, or pick a recipe'}
      marks={triggers.map((t) => ({ id: t.id, label: t.label || t.phrase || 'Trigger', x: t.x, y: t.y, w: t.w, h: t.h }))}
      selected={selected}
      canDraw={redraw !== null || !full}
      onDraw={onDraw}
      onClose={onClose}
      head={
        <select
          aria-label="Add from a recipe"
          value=""
          disabled={full}
          onChange={(e) => {
            if (e.target.value) addRecipe(e.target.value as RecipeId);
          }}
        >
          <option value="">Add from a recipe…</option>
          {orderedRecipes(recipes).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      }
    >
      {triggers.map((t) => {
        const problem = t.phrase || t.regex ? phraseProblem(t.phrase, t.regex) : null;
        const recipe = orderedRecipes().find((r) => r.phrase === t.phrase);
        return (
          <li key={t.id} className={`trigger-edit ${selected === t.id ? 'is-selected' : ''}`} onClick={() => setSelected(t.id)}>
            <input value={t.label} placeholder="Name" onChange={(e) => edit(t.id, { label: e.target.value })} />
            <button
              className="icon-btn"
              title="Remove this trigger"
              onClick={() => mutatePreset((d) => void (d.triggers = d.triggers.filter((x) => x.id !== t.id)))}
            >
              <Icon name="x" size={14} />
            </button>
            <div className="trigger-edit__more">
              <input
                value={t.phrase}
                maxLength={MAX_PHRASE}
                placeholder={t.action.kind === 'slotDown' ? '{name} fainted!' : 'Words to look for, e.g. YOU DIED'}
                aria-label="Words to look for"
                onChange={(e) => edit(t.id, { phrase: e.target.value })}
              />
              <label className="inline" title="Treat the words as a pattern (a regular expression)">
                <input type="checkbox" checked={t.regex} onChange={(e) => edit(t.id, { regex: e.target.checked })} /> Pattern
              </label>
              {problem && <small className="trigger-edit__problem">{problem}</small>}
              <select
                aria-label="What to do"
                value={t.action.kind}
                onChange={(e) => {
                  const kind = e.target.value as TriggerAction['kind'];
                  edit(t.id, { action: kind === 'counter' ? { kind, counterId: counters[0]?.id ?? '' } : { kind } });
                }}
              >
                {TRIGGER_ACTIONS.map((k) => (
                  <option key={k} value={k}>
                    {ACTION_NAMES[k]}
                  </option>
                ))}
              </select>
              {t.action.kind === 'counter' && (
                <select
                  aria-label="Which counter"
                  value={t.action.counterId}
                  onChange={(e) => edit(t.id, { action: { kind: 'counter', counterId: e.target.value } })}
                >
                  <option value="">Pick a counter…</option>
                  {counters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label || 'Counter'}
                    </option>
                  ))}
                </select>
              )}
              {t.action.kind === 'slotDown' && !t.phrase.includes('{name}') && !t.regex && (
                <small className="trigger-edit__problem">Put {'{name}'} where the name shows up, like “{'{name}'} fainted!”.</small>
              )}
              {t.action.kind === 'counter' && counters.length === 0 && (
                <small className="trigger-edit__problem">This preset has no counters yet. Add one in the Progress panel.</small>
              )}
              <label className="inline" title="After it fires, the words must be gone this long before it can fire again, so one death screen counts once">
                Again after gone for
                <input
                  type="number"
                  min={1}
                  max={MAX_COOLDOWN}
                  value={t.cooldownSec}
                  onChange={(e) => edit(t.id, { cooldownSec: Math.min(MAX_COOLDOWN, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
                />
                s
              </label>
              <button className={`btn btn--small ${redraw === t.id ? 'btn--on' : ''}`} onClick={() => setRedraw(redraw === t.id ? null : t.id)}>
                {redraw === t.id ? 'Drag on the picture…' : 'Draw the box again'}
              </button>
              {recipe && <small className="muted">Usually at {recipe.where}.</small>}
            </div>
          </li>
        );
      })}
      {triggers.length === 0 && <li className="hud-editor__note muted">Pick a recipe above, or drag on the picture to make a box.</li>}
    </RegionEditor>
  );
}

// ---------- the stat box editor ----------

interface EditorProps {
  stream: MediaStream;
  hud: HudRegion[];
  suggestions: string[];
  mutatePreset: MutatePreset;
  onClose: () => void;
}

/** A still of the game to draw boxes on, with the boxes and their live readings beside it. */
function HudEditor({ stream, hud, suggestions, mutatePreset, onClose }: EditorProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const edit = (id: string, patch: Partial<HudRegion>) =>
    mutatePreset((d) => {
      const r = d.hud.find((x) => x.id === id);
      if (r) Object.assign(r, patch, 'x' in patch || 'numeric' in patch ? { value: '', at: 0 } : {});
    });
  const unused = suggestions.filter((s) => !hud.some((r) => r.label === s));

  return (
    <RegionEditor
      stream={stream}
      title="Draw a box around each number on your game’s screen"
      marks={hud.map((r) => ({ id: r.id, label: r.label, x: r.x, y: r.y, w: r.w, h: r.h }))}
      selected={selected}
      canDraw={hud.length < MAX_HUD}
      onDraw={(box) => {
        const id = uid();
        const label = unused[0] ?? `Stat ${hud.length + 1}`;
        mutatePreset((d) => void d.hud.push({ id, label, ...box, numeric: true, value: '', at: 0 }));
        setSelected(id);
      }}
      onClose={onClose}
    >
      {hud.map((r) => (
        <li key={r.id} className={selected === r.id ? 'is-selected' : ''} onClick={() => setSelected(r.id)}>
          <input value={r.label} placeholder="Name" onChange={(e) => edit(r.id, { label: e.target.value })} />
          <label className="inline" title="Reads digits only, which is more reliable for counts">
            <input type="checkbox" checked={r.numeric} onChange={(e) => edit(r.id, { numeric: e.target.checked })} /> Number
          </label>
          <span className="hud-editor__reading">{r.value || 'Reading…'}</span>
          <button
            className="icon-btn"
            title="Remove this box"
            onClick={() => mutatePreset((d) => void (d.hud = d.hud.filter((x) => x.id !== r.id)))}
          >
            <Icon name="x" size={14} />
          </button>
        </li>
      ))}
      {hud.length === 0 && <li className="hud-editor__note muted">Drag on the picture to make a box.</li>}
      {unused.length > 0 && (
        <li className="hud-editor__note">
          <small>Ideas:</small> {unused.join(', ')}
        </li>
      )}
    </RegionEditor>
  );
}
