// @vitest-environment jsdom
//
// The Game panel's header: the game source is one dropdown (not a row of buttons), and picking
// from it still switches the source. The capture hooks are faked; nothing here touches a camera.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardContext } from '../../components/boardContext';
import { defaultState } from '../../state/hydrate';
import { activePreset } from '../../state/presets';
import { GamePanel } from './GamePanel';

const pick = vi.hoisted(() => vi.fn());
vi.mock('../../media', () => ({
  useDeviceStream: () => ({ stream: null, error: null, retry: () => {} }),
  useVideoDevices: () => [],
  useWindowStream: () => ({ stream: null, error: null, pick }),
}));
vi.mock('../../clips/replay', () => ({ useReplayBuffer: () => {} }));
vi.mock('../../hud/reader', () => ({ shareGameStream: () => {} }));
vi.mock('../../steam', () => ({ useSteam: () => null }));
vi.mock('../../wow', () => ({ useWowStatus: () => null, useWowRunning: () => null, wowWindowMatch: () => null }));
vi.mock('../../../integrations/wow/useWowLink', () => ({ useWowLink: () => 0 }));

afterEach(() => {
  cleanup();
  pick.mockClear();
});

/** The preset data the panel last drew from, so a test can see what a pick saved. */
let data = activePreset(defaultState()).data;

function Harness() {
  const [state] = useState(() => ({ ...defaultState(), preset: 'smite2' as const }));
  const [d, setD] = useState(state.presets.smite2);
  data = d;
  const { def } = activePreset(state);
  return (
    <BoardContext.Provider value={{ editing: true, hide: () => {}, fitWidthToAspect: () => {}, nudge: () => false }}>
      <GamePanel
        id="game"
        title="Game"
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

const toolbar = () => document.querySelector<HTMLElement>('.game-toolbar')!;

describe('the Game panel header', () => {
  it('has one source dropdown, not a button for each source', () => {
    render(<Harness />);
    const header = within(toolbar());
    // No row of source buttons in the header (the empty panel's cards are a separate thing).
    expect(header.queryByRole('button', { name: 'Capture card' })).toBeNull();
    expect(header.queryByRole('button', { name: 'Green screen' })).toBeNull();
    const source = header.getByRole('button', { name: 'None' });
    expect(source.getAttribute('aria-haspopup')).toBe('menu');
    expect(source.getAttribute('aria-expanded')).toBe('false');
  });

  it('lists the sources and switches to the one picked', () => {
    render(<Harness />);
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'None' }));
    const items = screen.getAllByRole('menuitemradio').map((i) => i.textContent);
    expect(items).toEqual(expect.arrayContaining(['None', 'Capture card', 'Window', 'Green screen']));
    expect(screen.getByRole('menuitemradio', { name: 'None' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Green screen' }));
    expect(data.game.source).toBe('chroma');
    // The list closes and the header names the new source, with its own options (the color).
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(toolbar()).getByRole('button', { name: 'Green screen' })).toBeTruthy();
    expect(within(toolbar()).getByText('Color')).toBeTruthy();
  });

  it('opens the window picker straight away when Window is chosen', () => {
    render(<Harness />);
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'None' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Window' }));
    expect(data.game.source).toBe('window');
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('switches back to none', () => {
    render(<Harness />);
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'None' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Capture card' }));
    expect(data.game.source).toBe('device');
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Capture card' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'None' }));
    expect(data.game.source).toBe('none');
  });
});
