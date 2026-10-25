/** Whether this PC's locale writes the time with am / pm. */
export const localHour12 = (): boolean => !new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h2');
