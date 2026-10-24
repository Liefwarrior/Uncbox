export type GmailSettings = {
  /** Only unread messages. */
  gmailOnlyUnread: boolean;
  /** The label to watch, as a Gmail label id (INBOX by default). */
  gmailLabel: string;
  /** Show the details in stream mode too. Off by default: they're private. */
  showOnStream: boolean;
};

export const defaultGmailSettings = (): GmailSettings => ({ gmailOnlyUnread: false, gmailLabel: 'INBOX', showOnStream: false });

export function cleanGmailSettings(s: GmailSettings): GmailSettings {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s.gmailLabel)) s.gmailLabel = 'INBOX';
  return s;
}
