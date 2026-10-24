import { describe, expect, it } from 'vitest';
import { opensPalette } from './keys';

const press = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat', boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  ...mods,
});

/** Stands in for an element that is, or sits in, the Web widget's address bar. */
const field = (inAddressBar: boolean) => ({ closest: () => (inAddressBar ? {} : null) }) as unknown as EventTarget;

describe('opensPalette', () => {
  it('opens on Ctrl+K and Ctrl+Shift+P, in either case', () => {
    expect(opensPalette(press('k', { ctrlKey: true }), null)).toBe(true);
    expect(opensPalette(press('K', { ctrlKey: true }), null)).toBe(true);
    expect(opensPalette(press('P', { ctrlKey: true, shiftKey: true }), null)).toBe(true);
    expect(opensPalette(press('k', { metaKey: true }), null)).toBe(true);
  });

  it('needs the control key, and leaves other combinations alone', () => {
    expect(opensPalette(press('k'), null)).toBe(false);
    expect(opensPalette(press('p', { ctrlKey: true }), null)).toBe(false);
    expect(opensPalette(press('k', { ctrlKey: true, shiftKey: true }), null)).toBe(false);
    expect(opensPalette(press('k', { ctrlKey: true, altKey: true }), null)).toBe(false);
    expect(opensPalette(press('j', { ctrlKey: true }), null)).toBe(false);
  });

  it('ignores a held key', () => {
    expect(opensPalette(press('k', { ctrlKey: true, repeat: true }), null)).toBe(false);
  });

  it('opens from other text fields', () => {
    expect(opensPalette(press('k', { ctrlKey: true }), field(false))).toBe(true);
  });

  it('leaves Ctrl+K to the address bar, but not Ctrl+Shift+P', () => {
    expect(opensPalette(press('k', { ctrlKey: true }), field(true))).toBe(false);
    expect(opensPalette(press('p', { ctrlKey: true, shiftKey: true }), field(true))).toBe(true);
  });
});
