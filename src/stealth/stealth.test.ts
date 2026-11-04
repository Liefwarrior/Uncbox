import { describe, expect, it } from 'vitest';
import { currentScene, isManagerView, takeStealthMessage } from './stealth';

describe('stealth mode on the page', () => {
  it('knows the manager’s page by its address', () => {
    expect(isManagerView('?native=1&view=manager')).toBe(true);
    expect(isManagerView('?view=manager')).toBe(true);
    expect(isManagerView('?native=1')).toBe(false);
    expect(isManagerView('?view=dashboard')).toBe(false);
    expect(isManagerView('')).toBe(false);
  });

  it('hands a starting stream the scene only while stealth mode is on', () => {
    const scene = { window: '42', cursor: false };
    takeStealthMessage({ type: 'scene', scene });
    expect(currentScene()).toBeNull();
    takeStealthMessage({ type: 'stealth', on: true });
    expect(currentScene()).toEqual(scene);
    takeStealthMessage({ type: 'stealth', on: false });
    expect(currentScene()).toBeNull();
    // Anything else from the app is none of its business.
    takeStealthMessage({ type: 'detached' });
    takeStealthMessage(null);
    expect(currentScene()).toBeNull();
  });
});
