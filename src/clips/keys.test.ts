import { describe, expect, it } from 'vitest';
// @ts-expect-error: a server module, no type declarations.
import { vkFor } from '../../server/hotkey.mjs';
import { isClipKey, keyLabel } from './keys';

describe('clip keys', () => {
  it('labels keys the way they read on the keyboard', () => {
    expect(keyLabel('Equal')).toBe('=');
    expect(keyLabel('Numpad5')).toBe('Num 5');
    expect(keyLabel('F9')).toBe('F9');
  });

  it('only offers keys that are not for typing or moving', () => {
    expect(['Equal', 'F13', 'Numpad0', 'PageDown', 'Backslash'].every(isClipKey)).toBe(true);
    expect(['KeyW', 'Digit1', 'Space', 'Enter', 'F25', 'ShiftLeft'].some(isClipKey)).toBe(false);
  });

  it('every key offered has a Windows key code on the server', () => {
    const offered = [
      ...['Equal', 'Minus', 'Comma', 'Period', 'Semicolon', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote'],
      ...['NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide', 'Numpad0', 'Numpad9'],
      ...['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Pause', 'ScrollLock', 'F1', 'F24'],
    ];
    for (const code of offered) {
      expect(isClipKey(code)).toBe(true);
      expect(vkFor(code)).toBeGreaterThan(0);
    }
    expect(vkFor('Equal')).toBe(0xbb);
    expect(vkFor('F24')).toBe(0x87);
  });
});
