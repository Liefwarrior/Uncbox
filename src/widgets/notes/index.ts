import { defineWidget } from '../types';
import { NotesPanel } from './NotesPanel';

export const notes = defineWidget({
  kind: 'notes',
  name: 'Notes',
  hint: 'A checklist',
  icon: 'pencil',
  category: 'Productivity',
  keywords: 'todo list checklist tasks',
  presets: ['pokemon', 'smite2', 'terminal', 'desk'],
  single: true,
  w: 6,
  h: 7,
  minW: 4,
  minH: 3,
  panel: NotesPanel,
});
