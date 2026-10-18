import { useState } from 'react';
import { note, type NoteItem } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { Icon } from './Icon';
import { Panel } from './Panel';

export function NotesPanel({ notes, title, mutatePreset }: { notes: NoteItem[]; title: string; mutatePreset: MutatePreset }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    mutatePreset((d) => void d.notes.push(note(text)));
    setDraft('');
  };

  return (
    <Panel
      id="notes"
      title={title}
      empty={notes.length === 0}
      actions={
        notes.some((n) => n.done) && (
          <button
            className="btn btn--small"
            title="Remove checked items"
            onClick={() => mutatePreset((d) => void (d.notes = d.notes.filter((n) => !n.done)))}
          >
            Clear done
          </button>
        )
      }
    >
      <ul className="notes">
        {notes.map((n, i) => (
          <li key={n.id} className={`note ${n.done ? 'is-done' : ''}`}>
            <button
              className={`check ${n.done ? 'on' : ''}`}
              title={n.done ? 'Uncheck' : 'Check off'}
              onClick={() => mutatePreset((d) => void (d.notes[i].done = !d.notes[i].done))}
            >
              <Icon name="check" size={12} />
            </button>
            <input
              className="ghost-input"
              value={n.text}
              onChange={(e) => mutatePreset((d) => void (d.notes[i].text = e.target.value))}
            />
            <button className="icon-btn ctl" title="Delete" onClick={() => mutatePreset((d) => void d.notes.splice(i, 1))}>
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="note-add ctl"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={draft} placeholder="Add a line…" onChange={(e) => setDraft(e.target.value)} />
        <button className="icon-btn" type="submit" title="Add" disabled={!draft.trim()}>
          <Icon name="plus" size={14} />
        </button>
      </form>
    </Panel>
  );
}
