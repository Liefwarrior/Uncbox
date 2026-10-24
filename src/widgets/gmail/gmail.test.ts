import { describe, expect, it } from 'vitest';
import { type GmailSummary, relativeTime, shouldRedact, streamView, summaryUrl, unreadText } from './gmail';

const NOW = new Date(2026, 9, 20, 14, 0).getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('relativeTime', () => {
  it('counts minutes, then hours', () => {
    expect(relativeTime(ago(20_000), NOW)).toBe('now');
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5m');
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe('59m');
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3h');
  });

  it('then says Yesterday, the weekday, and the date', () => {
    const day = (days: number) => new Date(2026, 9, 20 - days, 9, 0).toISOString();
    expect(relativeTime(day(1), NOW)).toBe('Yesterday');
    expect(relativeTime(day(3), NOW)).toBe(new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 9, 17, 9)));
    expect(relativeTime(day(10), NOW)).toMatch(/Oct.*10|10.*Oct/);
    expect(relativeTime(new Date(2025, 2, 4, 9).toISOString(), NOW)).toMatch(/2025/);
  });

  it('is empty when the date is missing or wrong', () => {
    expect(relativeTime('', NOW)).toBe('');
    expect(relativeTime('whenever', NOW)).toBe('');
  });
});

describe('the list and its count', () => {
  it('asks for the label and “only unread” the widget is set to', () => {
    expect(summaryUrl('INBOX', false)).toBe('/api/gmail/summary?label=INBOX&unread=0');
    expect(summaryUrl('Label_12', true)).toBe('/api/gmail/summary?label=Label_12&unread=1');
    expect(summaryUrl('', false)).toBe('/api/gmail/summary?label=INBOX&unread=0');
  });

  it('words the count', () => {
    expect(unreadText(12)).toBe('12 unread');
    expect(unreadText(1)).toBe('1 unread');
    expect(unreadText(0)).toBe('No unread');
  });
});

describe('stream mode', () => {
  const summary: GmailSummary = {
    label: { id: 'INBOX', name: 'Inbox' },
    unread: 12,
    threadsUnread: 9,
    messages: [{ id: 'm1', threadId: 't1', from: 'Dr. Private', subject: 'Your results', date: '', unread: true, snippet: 'Dear patient', link: 'https://mail.google.com/mail/u/0/#inbox/t1' }],
  };

  it('hides the details in stream mode unless “Show on stream” is on', () => {
    expect(shouldRedact(true, false)).toBe(true);
    expect(shouldRedact(true, true)).toBe(false);
    expect(shouldRedact(false, false)).toBe(false);
    expect(shouldRedact(false, true)).toBe(false);
  });

  it('keeps only the count when hiding', () => {
    const hidden = streamView(summary, true);
    expect(hidden).toEqual({ unread: 12, messages: [] });
    expect(JSON.stringify(hidden)).not.toMatch(/Private|results|patient|t1/);
  });

  it('keeps everything when showing', () => {
    expect(streamView(summary, false)).toEqual({ unread: 12, messages: summary.messages });
  });
});
