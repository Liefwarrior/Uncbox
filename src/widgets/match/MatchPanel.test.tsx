// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardContext } from '../../components/boardContext';
import { defaultState } from '../../state/hydrate';
import { SMITE_ROLES } from '../../state/model';
import { activePreset } from '../../state/presets';
import { MatchPanel } from './MatchPanel';

afterEach(cleanup);

/** The preset data the panel last drew from, so a test can see what a click saved. */
let data = activePreset({ ...defaultState(), preset: 'smite2' }).data;

function Harness({ role = '' }: { role?: string }) {
  const [state] = useState(() => {
    const s = { ...defaultState(), preset: 'smite2' as const };
    s.presets.smite2.match.role = role as never;
    return s;
  });
  const [d, setD] = useState(state.presets.smite2);
  data = d;
  const { def } = activePreset(state);
  return (
    <BoardContext.Provider value={{ editing: true, hide: () => {}, fitWidthToAspect: () => {}, nudge: () => false }}>
      <MatchPanel
        id="match"
        title="Match"
        state={state}
        data={d}
        def={def}
        mutate={() => {}}
        mutatePreset={(recipe) =>
          setD((prev) => {
            const next = structuredClone(prev);
            recipe(next);
            return next;
          })
        }
      />
    </BoardContext.Provider>
  );
}

describe('the Match widget', () => {
  it('picks the role from one select instead of five chips', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Jungle' })).toBeNull();
    const role = screen.getByRole('combobox', { name: 'Role' }) as HTMLSelectElement;
    expect([...role.options].map((o) => o.textContent)).toEqual(['Role', ...SMITE_ROLES]);
    expect(role.value).toBe('');

    fireEvent.change(role, { target: { value: 'Jungle' } });
    expect(data.match.role).toBe('Jungle');
    expect((screen.getByRole('combobox', { name: 'Role' }) as HTMLSelectElement).value).toBe('Jungle');

    // It can be changed, and cleared.
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'Carry' } });
    expect(data.match.role).toBe('Carry');
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: '' } });
    expect(data.match.role).toBe('');
  });

  it('shows a role that was already set', () => {
    render(<Harness role="Support" />);
    expect((screen.getByRole('combobox', { name: 'Role' }) as HTMLSelectElement).value).toBe('Support');
    // The name is also drawn as plain text, which is what shows on stream.
    expect(document.querySelector('.match__role-text')?.textContent).toBe('Support');
  });

  it('draws no text for the role when there is none', () => {
    render(<Harness />);
    expect(document.querySelector('.match__role-text')).toBeNull();
  });

  it('keeps the kills counting', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add one (Kills)' }));
    expect(data.match.k).toBe(1);
  });
});
