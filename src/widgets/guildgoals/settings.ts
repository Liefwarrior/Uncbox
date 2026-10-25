export type GoalsSettings = {
  /** Leave out raids with no kills yet. */
  hideUntouched: boolean;
  /** List each raid's bosses, not just how far through it is. */
  showBosses: boolean;
};

export const defaultGoalsSettings = (): GoalsSettings => ({ hideUntouched: false, showBosses: true });
