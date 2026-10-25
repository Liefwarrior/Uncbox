export type NotificationsSettings = {
  /** Only these apps (comma-separated, as listed), or '' for all. */
  apps: string;
  /** Show the message itself, not just who it's from. Off by default: it's on stream. */
  showBody: boolean;
};

export const defaultNotificationsSettings = (): NotificationsSettings => ({ apps: '', showBody: false });
