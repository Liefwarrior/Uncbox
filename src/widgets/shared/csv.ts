// A spreadsheet file (CSV) for loot councils and DKP sheets: rows in, text out, and a download.

export type Cell = string | number | boolean | null | undefined;

/** Text a spreadsheet would run as a formula ("=SUM(…)", "@x") is made plain by a leading quote mark. */
function plain(text: string): string {
  return /^[=@\t\r]/.test(text) || /^[+-](?![\d.]+$)/.test(text) ? `'${text}` : text;
}

/** One cell: quoted when it holds a comma, a quote or a line break, with quotes doubled. */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? plain(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows as CSV text (lines end in CRLF, which spreadsheets expect). */
export function toCsv(rows: Cell[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-24" for a time in milliseconds (this PC's day). */
export function csvDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-10-24 19:30" for a time in milliseconds. */
export function csvDateTime(ms: number): string {
  const d = new Date(ms);
  return `${csvDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Saves text as a file through a normal download. A byte order mark comes first, so Excel reads names like "Zoë" right. */
export function downloadCsv(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
