// The keys the clip hotkey can be, by KeyboardEvent.code. server/hotkey.mjs turns each into a
// Windows key code, so a new key needs adding there too. Letters and digits are left out on
// purpose: they're for typing and moving, and would set off clips all the time.

const NAMED: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  Backslash: '\\',
  BracketRight: ']',
  Quote: "'",
  NumpadMultiply: 'Num *',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadDecimal: 'Num .',
  NumpadDivide: 'Num /',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Pause: 'Pause',
  ScrollLock: 'Scroll Lock',
};

export const DEFAULT_CLIP_KEY = 'Equal';

export function isClipKey(code: string): boolean {
  if (code in NAMED) return true;
  if (/^Numpad\d$/.test(code)) return true;
  const f = /^F(\d{1,2})$/.exec(code);
  return f !== null && Number(f[1]) >= 1 && Number(f[1]) <= 24;
}

/** "Equal" → "=", "Numpad5" → "Num 5", "F9" → "F9". */
export function keyLabel(code: string): string {
  return NAMED[code] ?? code.replace(/^Numpad/, 'Num ');
}
