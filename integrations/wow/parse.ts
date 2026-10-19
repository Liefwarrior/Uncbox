// Turns the addon's texts into dashboard state. Fields are split by \x1f, quest records by \x1e;
// see addon/Uncbox/Uncbox.lua for what each field is.

import type { CharacterState, Quest, QuestState } from '../../src/state/model';

const FIELD = '\x1f';
const RECORD = '\x1e';

const CLASS_NAMES: Record<string, string> = {
  DEATHKNIGHT: 'Death Knight',
  DEMONHUNTER: 'Demon Hunter',
};

/** WARRIOR → Warrior: the names src/presets.ts colors by. */
export function className(token: string): string {
  return CLASS_NAMES[token] ?? token.charAt(0) + token.slice(1).toLowerCase();
}

/** 874012 copper → "87g 40s". */
export function formatMoney(copper: number): string {
  const g = Math.floor(copper / 10000);
  const s = Math.floor(copper / 100) % 100;
  const c = copper % 100;
  if (g > 0) return `${g.toLocaleString('en-US')}g ${s}s`;
  return s > 0 ? `${s}s ${c}c` : `${c}c`;
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/** Everything on the character sheet except the hardcore flag, which stays manual. */
export type CharacterPatch = Omit<CharacterState, 'hardcore'>;

export function parseCharacter(text: string): CharacterPatch | null {
  const f = text.split(FIELD);
  if (f[0] !== '1' || f.length < 12) return null;
  const [, name, realm, guild, race, cls, level, maxLevel, xp, xpMax, copper, zone] = f;
  const max = num(xpMax);
  return {
    name,
    realm,
    guild,
    race,
    cls: className(cls),
    level: Math.max(1, num(level)),
    maxLevel: Math.max(1, num(maxLevel)),
    xp: max > 0 ? Math.round((num(xp) / max) * 1000) / 10 : 0,
    gold: formatMoney(num(copper)),
    zone,
  };
}

const STATES: QuestState[] = ['open', 'complete', 'failed'];

export function parseQuests(text: string): Quest[] {
  if (!text) return [];
  return text.split(RECORD).map((record) => {
    const [title, level, state, ...rest] = record.split(FIELD);
    const objectives = [];
    for (let i = 0; i + 1 < rest.length; i += 2) objectives.push({ done: rest[i] === '1', text: rest[i + 1] });
    return { title, level: num(level), state: STATES[num(state)] ?? 'open', objectives };
  });
}
