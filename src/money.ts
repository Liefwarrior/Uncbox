// Money for the auction house widget: whole copper everywhere, shown as "12g 34s 56c". The server
// has the same helpers in server/money.mjs; keep the two in step.

export const COPPER_PER_SILVER = 100;
export const COPPER_PER_GOLD = 10000;

/** 123456 → "12g 34s 56c". Zero parts are left out ("12g 56c"), zero is "0c", a loss starts with "-". */
export function formatMoney(copper: number): string {
  const n = Math.round(Number(copper));
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const g = Math.floor(abs / COPPER_PER_GOLD);
  const s = Math.floor(abs / COPPER_PER_SILVER) % 100;
  const c = abs % 100;
  const parts: string[] = [];
  if (g) parts.push(`${g}g`);
  if (s) parts.push(`${s}s`);
  if (c || !parts.length) parts.push(`${c}c`);
  return (n < 0 ? '-' : '') + parts.join(' ');
}

/** "12g 34s 56c", "1g50s", "75s" or "250" (bare numbers are copper) → copper; null when it isn't money. */
export function parseMoney(text: string): number | null {
  const t = String(text ?? '').trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)\s*g)?\s*(?:(\d+)\s*s)?\s*(?:(\d+)\s*c)?$/.exec(t);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  return Number(m[1] ?? 0) * COPPER_PER_GOLD + Number(m[2] ?? 0) * COPPER_PER_SILVER + Number(m[3] ?? 0);
}
