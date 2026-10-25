import { type Counter, counter, type ScreenTrigger, uid } from '../state/model';

// Ready-made screen triggers: the phrase, the action and roughly where on the screen it shows up
// are filled in, and the user only has to check the box sits over the right place.

export type RecipeId = 'souls' | 'gta' | 'gameover' | 'nuzlocke' | 'defeat';

export interface TriggerRecipe {
  id: RecipeId;
  /** What the menu says. */
  name: string;
  /** Names the trigger once added. */
  label: string;
  phrase: string;
  /** "counter" adds 1 to the counter called `counter`; "slotDown" marks the {name} in the phrase down. */
  action: 'counter' | 'slotDown';
  counter?: string;
  /** Where the words show up, in plain words, and as a box in percent of the picture. */
  where: string;
  box: { x: number; y: number; w: number; h: number };
  cooldownSec: number;
}

export const RECIPES: TriggerRecipe[] = [
  {
    id: 'souls',
    name: 'Death counter: Souls games (YOU DIED)',
    label: 'You died',
    phrase: 'YOU DIED',
    action: 'counter',
    counter: 'Deaths',
    where: 'the middle of the screen',
    box: { x: 25, y: 38, w: 50, h: 24 },
    cooldownSec: 8,
  },
  {
    id: 'gta',
    name: 'Death counter: GTA (WASTED)',
    label: 'Wasted',
    phrase: 'WASTED',
    action: 'counter',
    counter: 'Deaths',
    where: 'the middle of the screen',
    box: { x: 30, y: 38, w: 40, h: 24 },
    cooldownSec: 8,
  },
  {
    id: 'gameover',
    name: 'Death counter: generic (Game Over)',
    label: 'Game over',
    phrase: 'Game Over',
    action: 'counter',
    counter: 'Deaths',
    where: 'the middle of the screen',
    box: { x: 20, y: 30, w: 60, h: 40 },
    cooldownSec: 8,
  },
  {
    id: 'nuzlocke',
    name: 'Nuzlocke: mark fainted Pokémon ({name} fainted!)',
    label: 'Fainted Pokémon',
    phrase: '{name} fainted!',
    action: 'slotDown',
    where: 'the battle text box at the bottom',
    box: { x: 5, y: 72, w: 90, h: 25 },
    cooldownSec: 4,
  },
  {
    id: 'defeat',
    name: 'Defeat counter (DEFEAT)',
    label: 'Defeat',
    phrase: 'DEFEAT',
    action: 'counter',
    counter: 'Defeats',
    where: 'the middle of the screen',
    box: { x: 25, y: 30, w: 50, h: 30 },
    cooldownSec: 8,
  },
];

export const recipeById = (id: RecipeId): TriggerRecipe => RECIPES.find((r) => r.id === id)!;

/** The recipes with the preset's own suggestions first (Pokémon lists the Nuzlocke one first). */
export function orderedRecipes(first: RecipeId[] = []): TriggerRecipe[] {
  const rest = RECIPES.filter((r) => !first.includes(r.id));
  return [...first.map(recipeById), ...rest];
}

/**
 * A trigger from a recipe, switched on. A counter recipe uses the preset's counter of that name,
 * or brings a new one (`newCounter`, for the caller to add) when there isn't one.
 */
export function triggerFromRecipe(r: TriggerRecipe, counters: Counter[]): { trigger: ScreenTrigger; newCounter?: Counter } {
  const base = { id: uid(), label: r.label, ...r.box, phrase: r.phrase, regex: false, enabled: true, cooldownSec: r.cooldownSec, at: 0 };
  if (r.action === 'slotDown') return { trigger: { ...base, action: { kind: 'slotDown' } } };
  const label = r.counter ?? 'Deaths';
  const found = counters.find((c) => c.label.trim().toLowerCase() === label.toLowerCase());
  const newCounter = found ? undefined : counter(label);
  return { trigger: { ...base, action: { kind: 'counter', counterId: (found ?? newCounter!).id } }, newCounter };
}
