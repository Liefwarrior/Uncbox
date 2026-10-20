// When a key press opens the command palette.

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

/** Where Ctrl+K belongs to the field instead: the Web widget's address bar, as in a browser's own. */
export function inAddressBar(target: EventTarget | null): boolean {
  const el = target as Pick<Element, 'closest'> | null;
  return Boolean(el?.closest?.('.web-bar__address, input[type="url"]'));
}

/**
 * Ctrl+K opens the palette from anywhere, even in other text fields (none of them uses it), but
 * not in an address bar. Ctrl+Shift+P opens it everywhere, so an address bar still has a way.
 */
export function opensPalette(e: KeyLike, target: EventTarget | null): boolean {
  if (e.repeat || e.altKey || !(e.ctrlKey || e.metaKey)) return false;
  const key = e.key.toLowerCase();
  if (key === 'p') return e.shiftKey;
  return key === 'k' && !e.shiftKey && !inAddressBar(target);
}
