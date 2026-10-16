import { useState } from 'react';
import { type NoteItem, uid } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { Icon } from './Icon';
import { Panel } from './Panel';

export function NotesPanel({ notes, mutate }: { notes: NoteItem[]; mutate: Mutate }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    mutate((s) => void s.notes.push({ id: uid(), text, done: false }));
    setDraft('');
  };

  return (
    <Panel
      title="Notes"
      className="panel--notes"
      actions={
        notes.some((n) => n.done) && (
          <button
            className="btn btn--small"
            title="Remove checked items"
            onClick={() => mutate((s) => void (s.notes = s.notes.filter((n) => !n.done)))}
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
              onClick={() => mutate((s) => void (s.notes[i].done = !s.notes[i].done))}
            >
              {n.done && <Icon name="check" size={12} />}
            </button>
            <input
              className="ghost-input"
              value={n.text}
              onChange={(e) => mutate((s) => void (s.notes[i].text = e.target.value))}
            />
            <button
              className="icon-btn ctl"
              title="Delete"
              onClick={() => mutate((s) => void s.notes.splice(i, 1))}
            >
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
        <input value={draft} placeholder="Add a goal or note…" onChange={(e) => setDraft(e.target.value)} />
        <button className="icon-btn" type="submit" title="Add" disabled={!draft.trim()}>
          <Icon name="plus" size={14} />
        </button>
      </form>
    </Panel>
  );
}
