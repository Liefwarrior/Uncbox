export type CountdownSettings = {
  /** When it ends (ms since 1970), or 0 if not set. */
  target: number;
  /** What's coming. */
  text: string;
};

export const defaultCountdownSettings = (): CountdownSettings => ({ target: 0, text: '' });
