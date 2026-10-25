export type TextSettings = {
  /** What it says. */
  text: string;
};

export const defaultTextSettings = (): TextSettings => ({ text: '' });
