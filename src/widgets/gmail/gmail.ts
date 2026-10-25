// The Gmail glance widget's logic, as plain functions so it can be tested. The data comes from the
// Uncbox server (server/gmail.mjs), which reads headers and labels only, never message text.

export interface GmailMessage {
  id: string;
  threadId: string;
  /** The sender's display name, or their address if they have no name. */
  from: string;
  subject: string;
  /** When it arrived (ISO), or ''. */
  date: string;
  unread: boolean;
  /** Only if Google sent one with the headers. */
  snippet?: string;
  /** Opens the conversation in Gmail. */
  link: string;
}

export interface GmailSummary {
  label: { id: string; name: string };
  unread: number;
  threadsUnread: number;
  messages: GmailMessage[];
}

export interface GmailLabel {
  id: string;
  name: string;
  system: boolean;
}

export const DEFAULT_LABEL = 'INBOX';

/** The address the page asks for, for the label and "only unread" the widget is set to. */
export function summaryUrl(label: string, onlyUnread: boolean): string {
  const q = new URLSearchParams({ label: label || DEFAULT_LABEL, unread: onlyUnread ? '1' : '0' });
  return `/api/gmail/summary?${q}`;
}

/** "12 unread", "1 unread", "No unread". */
export const unreadText = (count: number) => (count > 0 ? `${count.toLocaleString()} unread` : 'No unread');

/** "now", "5m", "3h", "Yesterday", "Tue", "Mar 4", and with the year for an older one. */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return '';
  const age = now - t;
  if (age < 60_000) return 'now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  const day = new Date(t);
  const today = new Date(now);
  const daysAgo = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) / 86_400_000);
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo > 1 && daysAgo < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(t);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).format(t);
}

// ---- on air ----

/**
 * While private (on air: stream mode, OBS live, or the On air switch) everyone watching sees the screen, so the widget keeps who wrote to
 * you and about what to itself unless "Show on stream" is on.
 */
export const shouldRedact = (isPrivate: boolean, showOnStream: boolean) => isPrivate && !showOnStream;

/** What a stream gets to see: with `redact`, the count and nothing else. */
export function streamView(summary: GmailSummary, redact: boolean): { unread: number; messages: GmailMessage[] } {
  return { unread: summary.unread, messages: redact ? [] : summary.messages };
}
