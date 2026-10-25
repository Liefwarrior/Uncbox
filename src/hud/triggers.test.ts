import { describe, expect, it } from 'vitest';
import { defaultPresetData } from '../state/hydrate';
import { counter, emptyTrigger, milestone, type PresetData, type ScreenTrigger, type SlotItem } from '../state/model';
import screens from './fixtures/screens.ocr.json';
import { orderedRecipes, RECIPES, recipeById, triggerFromRecipe } from './recipes';
import {
  describeTest,
  editDistance,
  findApprox,
  firedText,
  freshDebounce,
  matchPhrase,
  phraseProblem,
  planFire,
  readingKey,
  resolveSlot,
  squash,
  stepDebounce,
} from './triggers';

const slot = (name: string, down = false): SlotItem => ({ id: `s-${name}`, name, detail: '', image: '', down });

describe('fuzzy search', () => {
  it('squashes text to lower case letters with lookalikes folded', () => {
    expect(squash('Y0U DlED!').s).toBe('youdied');
    expect(squash('Pokémon').s).toBe('pokemon');
    expect(squash('A-B c').at).toEqual([0, 2, 4]);
  });

  it('measures edits', () => {
    expect(editDistance('pidgeoto', 'pidgeotto')).toBe(1);
    expect(editDistance('same', 'same')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('finds the best place a word is in a longer text', () => {
    expect(findApprox('xxfaintedyy', 'fainted', 0)).toEqual({ start: 2, end: 9, dist: 0 });
    expect(findApprox('xxfaintdyy', 'fainted', 1)).toMatchObject({ dist: 1 });
    expect(findApprox('xxfaintdyy', 'fainted', 0)).toBeNull();
    expect(findApprox('abc', '', 3)).toBeNull();
  });
});

describe('matching a phrase against OCR text', () => {
  it('finds a death screen through real-looking noise', () => {
    const cases: [string, { text: string; match: boolean }[]][] = [
      ['YOU DIED', screens.souls],
      ['WASTED', screens.gta],
      ['Game Over', screens.gameover],
    ];
    for (const [phrase, texts] of cases) {
      for (const { text, match } of texts) expect(matchPhrase(text, phrase) !== null, `${phrase} in "${text}"`).toBe(match);
    }
  });

  it('allows one mistake per six letters, no more', () => {
    expect(matchPhrase('DEFEAD', 'DEFEAT')).not.toBeNull();
    expect(matchPhrase('DEFEXD', 'DEFEAT')).toBeNull();
    // Short words must be exact: five letters get no mistakes.
    expect(matchPhrase('VICTOR', 'VICTORY')).not.toBeNull();
    expect(matchPhrase('LOSE', 'LOSS')).toBeNull();
  });

  it('ignores case, spacing and punctuation', () => {
    expect(matchPhrase('  you...  died  ', 'YOU DIED')).not.toBeNull();
    expect(matchPhrase('', 'YOU DIED')).toBeNull();
    expect(matchPhrase('YOU DIED', '')).toBeNull();
  });

  it('takes the name out of a {name} phrase', () => {
    for (const { text, name } of screens.battle) {
      expect(matchPhrase(text, '{name} fainted!')?.name ?? null, text).toBe(name);
    }
  });

  it('wants the words around the name', () => {
    expect(matchPhrase('fainted!', '{name} fainted!')).toBeNull();
    expect(matchPhrase('Go! Charmander!', '{name} fainted!')).toBeNull();
    expect(matchPhrase('The foe Pidgey fainted', 'The foe {name} fainted')?.name).toBe('Pidgey');
    expect(matchPhrase('Gold: Pikachu', 'Gold: {name}')?.name).toBe('Pikachu');
    // A whole sentence in front of the words is not a name.
    expect(matchPhrase('The wild Rattata used Tackle on your Pidgeotto and it fainted!', '{name} fainted!')).toBeNull();
  });

  it('can use a pattern instead', () => {
    expect(matchPhrase('Boss defeated: Ornstein', 'defeated: (?<name>\\w+)', true)?.name).toBe('Ornstein');
    expect(matchPhrase('You Died', '^you (died|fell)$', true)).not.toBeNull();
    expect(matchPhrase('You Won', '^you (died|fell)$', true)).toBeNull();
    expect(matchPhrase('anything', '(unclosed', true)).toBeNull();
  });

  it('says what is wrong with a phrase', () => {
    expect(phraseProblem('', false)).toMatch(/words/);
    expect(phraseProblem('YOU DIED', false)).toBeNull();
    expect(phraseProblem('(oops', true)).toMatch(/valid/);
    expect(phraseProblem('a|b', true)).toBeNull();
  });
});

describe('finding the party member', () => {
  const party = [slot('PIDGEOTTO'), slot('Rattata'), slot('Mr. Mime')];

  it('forgives a misread letter', () => {
    expect(resolveSlot('Pidgeoto', party)?.name).toBe('PIDGEOTTO');
    expect(resolveSlot('Pidgeotto', party)?.name).toBe('PIDGEOTTO');
    expect(resolveSlot('mr mime', party)?.name).toBe('Mr. Mime');
  });

  it('does not match a name nobody has', () => {
    expect(resolveSlot('Wild RATTATA', party)).toBeNull();
    expect(resolveSlot('Zubat', party)).toBeNull();
    expect(resolveSlot('', party)).toBeNull();
  });

  it('prefers the exact name over a similar one', () => {
    const similar = [slot('Pidgeot'), slot('Pidgeotto')];
    expect(resolveSlot('Pidgeot', similar)?.name).toBe('Pidgeot');
    expect(resolveSlot('Pidgeotto', similar)?.name).toBe('Pidgeotto');
    expect(resolveSlot('Charmeleon', [slot('Charmeleon'), slot('Charmeleun')])?.name).toBe('Charmeleon');
    // One letter off two different long names: better to mark nothing than the wrong one.
    expect(resolveSlot('Charmelion', [slot('Charmeleon'), slot('Charmelaon')])).toBeNull();
  });

  it('does not guess at short names', () => {
    expect(resolveSlot('Mew', [slot('Mow')])).toBeNull();
    expect(resolveSlot('Mew', [slot('Mew')])?.name).toBe('Mew');
  });

  it('picks the one still up when two share a name', () => {
    const two = [slot('Rattata', true), { ...slot('Rattata'), id: 'second' }];
    expect(resolveSlot('Rattata', two)?.id).toBe('second');
  });
});

describe('firing once per sighting', () => {
  const run = (frames: [number, string | null][], cooldown = 5) => {
    let state = freshDebounce();
    const fires: number[] = [];
    for (const [t, key] of frames) {
      const step = stepDebounce(state, key, t * 1000, cooldown);
      state = step.state;
      if (step.fire) fires.push(t);
    }
    return fires;
  };

  it('fires once while the phrase stays up', () => {
    expect(run([[0, ''], [1, ''], [2, ''], [3, ''], [9, ''], [30, '']])).toEqual([0]);
  });

  it('fires again after the phrase has been gone long enough', () => {
    expect(run([[0, ''], [1, null], [2, null], [7, null], [8, ''], [9, '']])).toEqual([0, 8]);
  });

  it('does not fire again after a short gap, such as one bad reading', () => {
    expect(run([[0, ''], [1, null], [2, ''], [3, null], [5, ''], [6, '']])).toEqual([0]);
  });

  it('counts the gap from when the phrase went away, not from the last firing', () => {
    // Up until t=20, gone from 21 but back at 24: not armed. Gone again from 25, armed at 30.
    expect(run([[0, ''], [20, ''], [21, null], [24, ''], [25, null], [30, null], [31, '']])).toEqual([0, 31]);
  });

  it('uses the cooldown it is given', () => {
    expect(run([[0, ''], [1, null], [3, null], [4, '']], 2)).toEqual([0, 4]);
  });

  it('fires for a different party member at once, but not the same one twice', () => {
    expect(run([[0, 'a'], [1, 'a'], [2, 'b'], [3, 'b'], [4, 'a']])).toEqual([0, 2, 4]);
  });

  it('fires the very first time it sees the phrase', () => {
    expect(run([[0, null], [1, '']])).toEqual([1]);
  });
});

/** A Pokémon-ish preset to fire triggers against. */
function nuzlocke(): { data: PresetData; deaths: string; t: ScreenTrigger } {
  const data = defaultPresetData('pokemon');
  data.slots[0] = slot('PIDGEOTTO');
  data.slots[1] = slot('Rattata');
  const deaths = data.counters.find((c) => c.label === 'Deaths')!.id;
  const t = { ...emptyTrigger(), phrase: '{name} fainted!', action: { kind: 'slotDown' as const } };
  return { data, deaths, t };
}

describe('doing something about it', () => {
  it('adds 1 to a counter, and undo takes it back', () => {
    const { data, deaths } = nuzlocke();
    const t = { ...emptyTrigger(), phrase: 'YOU DIED', action: { kind: 'counter' as const, counterId: deaths } };
    const fire = planFire(data, t, null)!;
    expect(fire.message).toBe('Deaths +1');
    const d = structuredClone(data);
    fire.apply(d);
    expect(d.counters.find((c) => c.id === deaths)!.value).toBe(1);
    fire.apply(d);
    fire.undo(d);
    expect(d.counters.find((c) => c.id === deaths)!.value).toBe(1);
    fire.undo(d);
    expect(d.counters.find((c) => c.id === deaths)!.value).toBe(0);
  });

  it('does nothing for a counter that is gone', () => {
    const { data } = nuzlocke();
    const t = { ...emptyTrigger(), action: { kind: 'counter' as const, counterId: 'gone' } };
    expect(planFire(data, t, null)).toBeNull();
  });

  it('marks the named party member down, and undo brings them back', () => {
    const { data, t } = nuzlocke();
    const fire = planFire(data, t, 'Pidgeoto')!;
    expect(fire.message).toBe('PIDGEOTTO marked down');
    const d = structuredClone(data);
    fire.apply(d);
    expect(d.slots.map((s) => s.down)).toEqual([true, false, false, false, false, false]);
    fire.undo(d);
    expect(d.slots.some((s) => s.down)).toBe(false);
  });

  it('does nothing for a name nobody has, a missing name, or someone already down', () => {
    const { data, t } = nuzlocke();
    expect(planFire(data, t, 'Wild RATTATA')).toBeNull();
    expect(planFire(data, t, null)).toBeNull();
    data.slots[0].down = true;
    expect(planFire(data, t, 'PIDGEOTTO')).toBeNull();
  });

  it('ticks the next milestone, and undo unticks that one', () => {
    const { data } = nuzlocke();
    data.milestones.items = [{ ...milestone('Brock'), done: true }, milestone('Misty'), milestone('Surge')];
    const t = { ...emptyTrigger(), action: { kind: 'milestone' as const } };
    const fire = planFire(data, t, null)!;
    expect(fire.message).toBe('Misty ticked');
    const d = structuredClone(data);
    fire.apply(d);
    expect(d.milestones.items.map((m) => m.done)).toEqual([true, true, false]);
    fire.undo(d);
    expect(d.milestones.items.map((m) => m.done)).toEqual([true, false, false]);
    d.milestones.items.forEach((m) => (m.done = true));
    expect(planFire(d, t, null)).toBeNull();
  });

  it('turns a reading into what to debounce on', () => {
    const { data, t } = nuzlocke();
    expect(readingKey(data, t, 'Pidgeoto fainted!')).toEqual({ key: 's-PIDGEOTTO', name: 'Pidgeoto' });
    expect(readingKey(data, t, 'Zubat fainted!')).toEqual({ key: null, name: 'Zubat' });
    expect(readingKey(data, t, 'Go! Charmander!')).toEqual({ key: null, name: null });
    const death = { ...emptyTrigger(), phrase: 'YOU DIED' };
    expect(readingKey(data, death, 'Y0U DlED').key).toBe('');
    expect(readingKey(data, death, 'nothing').key).toBeNull();
  });

  it('plays a whole Nuzlocke battle text: each faint once, enemy faints ignored', () => {
    const { data, t } = nuzlocke();
    let state = freshDebounce();
    const downed: string[] = [];
    const frames = ['Wild RATTATA fainted!', 'Pidgeoto fainted!', 'Pidgeoto fainted!', '', 'Rattata fainted!', 'Rattata fainted!'];
    frames.forEach((text, i) => {
      const { key, name } = readingKey(data, t, text);
      const step = stepDebounce(state, key, i * 1000, 5);
      state = step.state;
      const fire = step.fire ? planFire(data, t, name) : null;
      if (fire) {
        fire.apply(data);
        downed.push(fire.message);
      }
    });
    expect(downed).toEqual(['PIDGEOTTO marked down', 'Rattata marked down']);
  });

  it('describes what a test read', () => {
    const { data, deaths, t } = nuzlocke();
    const death = { ...emptyTrigger(), phrase: 'YOU DIED', action: { kind: 'counter' as const, counterId: deaths } };
    expect(describeTest(data, death, 'Y0U DlED')).toMatch(/a match.*Deaths \+1/);
    expect(describeTest(data, death, 'Press start')).toMatch(/isn’t “YOU DIED”/);
    expect(describeTest(data, death, '  ')).toMatch(/no text/);
    expect(describeTest(data, { ...death, phrase: '' }, 'x')).toMatch(/Type the words/);
    expect(describeTest(data, t, 'Pidgeoto fainted!')).toMatch(/PIDGEOTTO marked down/);
    expect(describeTest(data, t, 'Zubat fainted!')).toMatch(/nobody in the party is called that/);
    expect(describeTest(data, { ...death, action: { kind: 'counter', counterId: '' } }, 'YOU DIED')).toMatch(/Pick a counter/);
  });

  it('says when it last fired', () => {
    expect(firedText(0, 1000)).toBe('never');
    expect(firedText(1000, 3000)).toBe('just now');
    expect(firedText(1, 30_001)).toBe('30 s ago');
    expect(firedText(1, 300_001)).toBe('5 min ago');
    expect(firedText(1, 7_200_001)).toBe('2 h ago');
    expect(firedText(1, 3 * 86_400_001)).toBe('3 d ago');
  });
});

describe('recipes', () => {
  it('fills in the phrase, the action and where to look', () => {
    const souls = triggerFromRecipe(recipeById('souls'), []);
    expect(souls.trigger).toMatchObject({ phrase: 'YOU DIED', enabled: true, regex: false, cooldownSec: 8, at: 0 });
    expect(souls.trigger.w).toBeGreaterThan(0);
    expect(souls.newCounter).toMatchObject({ label: 'Deaths', value: 0 });
    expect(souls.trigger.action).toEqual({ kind: 'counter', counterId: souls.newCounter!.id });
  });

  it('uses the preset’s own counter of that name instead of making a new one', () => {
    const deaths = counter('deaths');
    const gta = triggerFromRecipe(recipeById('gta'), [counter('Bosses'), deaths]);
    expect(gta.newCounter).toBeUndefined();
    expect(gta.trigger.action).toEqual({ kind: 'counter', counterId: deaths.id });
    expect(triggerFromRecipe(recipeById('defeat'), [deaths]).newCounter?.label).toBe('Defeats');
  });

  it('makes the Nuzlocke recipe mark a party member down', () => {
    const n = triggerFromRecipe(recipeById('nuzlocke'), []);
    expect(n.trigger).toMatchObject({ phrase: '{name} fainted!', action: { kind: 'slotDown' } });
    expect(n.newCounter).toBeUndefined();
    expect(n.trigger.y).toBeGreaterThan(50);
  });

  it('keeps every recipe’s phrase valid and its box on the picture', () => {
    for (const r of RECIPES) {
      expect(phraseProblem(r.phrase, false), r.id).toBeNull();
      expect(r.box.x + r.box.w, r.id).toBeLessThanOrEqual(100);
      expect(r.box.y + r.box.h, r.id).toBeLessThanOrEqual(100);
      expect(matchPhrase(r.phrase.replace('{name}', 'Pikachu'), r.phrase), r.id).not.toBeNull();
    }
  });

  it('lists the preset’s suggestions first', () => {
    expect(orderedRecipes(['nuzlocke']).map((r) => r.id)).toEqual(['nuzlocke', 'souls', 'gta', 'gameover', 'defeat']);
    expect(orderedRecipes().map((r) => r.id)).toEqual(RECIPES.map((r) => r.id));
  });
});
