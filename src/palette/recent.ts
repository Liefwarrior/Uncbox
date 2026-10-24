// Which commands were used lately, newest first, so the palette can put them at the top. Kept in
// this browser only (localStorage), and it works without it.

const KEY = 'uncbox.palette.recent';
export const MAX_RECENT = 8;

/** The id moves to the front (once), and the list stays short. */
export function bump(recent: string[], id: string, max = MAX_RECENT): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}

export function loadRecent(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((r): r is string => typeof r === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function saveRecent(recent: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // Storage blocked or full: the palette just forgets what you used.
  }
}
