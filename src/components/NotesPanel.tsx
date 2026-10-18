import { useState } from 'react';
import { note, type NoteItem } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { offerUndo } from '../undo';
import { Icon } from './Icon';
import { Panel } from './Panel';

export function NotesPanel({ notes, title, mutatePreset }: { notes: NoteItem[]; title: string; mutatePreset: MutatePreset }) {
  const [draft, setDraft] = useState('');

  const remove = (n: NoteItem, i: number) => {
    mutatePreset((d) => void (d.notes = d.notes.filter((x) => x.id !== n.id)));
    offerUndo('Line deleted', () =>
      mutatePreset((d) => void (d.notes.some((x) => x.id === n.id) || d.notes.splice(Math.min(i, d.notes.length), 0, n))),
    );
  };

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
      menu={[
        {
          label: 'Remove checked items',
          icon: 'check',
          disabled: !notes.some((n) => n.done),
          onSelect: () => {
            const before = notes;
            const removed = new Set(notes.filter((n) => n.done).map((n) => n.id));
            mutatePreset((d) => void (d.notes = d.notes.filter((n) => !n.done)));
            // Put the removed lines back where they were, keeping any edits made since.
            offerUndo('Checked items removed', () =>
              mutatePreset((d) => {
                const now = new Map(d.notes.map((n) => [n.id, n]));
                const restored = before.filter((n) => removed.has(n.id) || now.has(n.id)).map((n) => now.get(n.id) ?? n);
                d.notes = [...restored, ...d.notes.filter((n) => !before.some((b) => b.id === n.id))];
              }),
            );
          },
        },
      ]}
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
            <button className="icon-btn ctl" title="Delete" onClick={() => remove(n, i)}>
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
