import { fold, type RaidSummary } from '../shared/wowGuild';

// The Guild goals checklist's logic: which bosses of each raid the guild has killed, from the
// boss kills the addon recorded. Raids it knows the bosses of list them all (so you can see
// what is left); any other raid lists what was killed.

export const KNOWN_RAIDS: { zone: string; bosses: string[] }[] = [
  { zone: 'Onyxia’s Lair', bosses: ['Onyxia'] },
  { zone: 'Molten Core', bosses: ['Lucifron', 'Magmadar', 'Gehennas', 'Garr', 'Shazzrah', 'Baron Geddon', 'Sulfuron Harbinger', 'Golemagg the Incinerator', 'Majordomo Executus', 'Ragnaros'] },
  { zone: 'Blackwing Lair', bosses: ['Razorgore the Untamed', 'Vaelastrasz the Corrupt', 'Broodlord Lashlayer', 'Firemaw', 'Ebonroc', 'Flamegor', 'Chromaggus', 'Nefarian'] },
  { zone: 'Zul’Gurub', bosses: ['High Priestess Jeklik', 'High Priest Venoxis', 'High Priestess Mar’li', 'High Priest Thekal', 'High Priestess Arlokk', 'Bloodlord Mandokir', 'Jin’do the Hexxer', 'Hakkar'] },
  { zone: 'Ruins of Ahn’Qiraj', bosses: ['Kurinnaxx', 'General Rajaxx', 'Moam', 'Buru the Gorger', 'Ayamiss the Hunter', 'Ossirian the Unscarred'] },
  { zone: 'Temple of Ahn’Qiraj', bosses: ['The Prophet Skeram', 'Bug Trio', 'Battleguard Sartura', 'Fankriss the Unyielding', 'Viscidus', 'Princess Huhuran', 'Twin Emperors', 'Ouro', 'C’Thun'] },
  { zone: 'Hyjal Summit', bosses: ['Rage Winterchill', 'Anetheron', 'Kaz’rogal', 'Azgalor', 'Archimonde'] },
  {
    zone: 'Naxxramas',
    bosses: ['Anub’Rekhan', 'Grand Widow Faerlina', 'Maexxna', 'Noth the Plaguebringer', 'Heigan the Unclean', 'Loatheb', 'Instructor Razuvious', 'Gothik the Harvester', 'The Four Horsemen', 'Patchwerk', 'Grobbulus', 'Gluth', 'Thaddius', 'Sapphiron', 'Kel’Thuzad'],
  },
];

/** A name for comparing: no case, accents, apostrophes or spaces ("Mar’li" is "marli"). */
const plain = (text: string): string => fold(text).replace(/[^a-z0-9]/g, '');

/** Whether a recorded boss name is this boss (the game may say "Majordomo Executus" for "Majordomo"). */
export function sameBoss(recorded: string, boss: string): boolean {
  const a = plain(recorded);
  const b = plain(boss);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)));
}

export interface GoalBoss {
  name: string;
  /** When the guild first killed it, or null. */
  killedAt: number | null;
}

export interface GoalRaid {
  zone: string;
  bosses: GoalBoss[];
  killed: number;
  /** How many bosses the raid has, or the number killed for a raid whose bosses aren't known. */
  total: number;
  /** Whether the whole list of bosses is known (so "3 of 10" means something). */
  known: boolean;
}

export interface Progression {
  raids: GoalRaid[];
  killed: number;
  total: number;
}

/** The first time each boss (by name) was killed, in each raid zone. */
function kills(raids: readonly RaidSummary[]): Map<string, { name: string; at: number }[]> {
  const byZone = new Map<string, { name: string; at: number }[]>();
  for (const raid of raids) {
    const zone = plain(raid.zone);
    if (!zone) continue;
    const list = byZone.get(zone) ?? [];
    for (const b of raid.bosses) {
      if (b.success !== true) continue;
      const at = b.endedAt ?? b.startedAt;
      const same = list.find((k) => sameBoss(k.name, b.name));
      if (same) same.at = Math.min(same.at, at);
      else list.push({ name: b.name, at });
    }
    byZone.set(zone, list);
  }
  return byZone;
}

/** Progress through every raid: the ones whose bosses are known first, in order, then any other raid with kills. */
export function progression(raids: readonly RaidSummary[], opts: { hideUntouched: boolean }): Progression {
  const byZone = kills(raids);
  const out: GoalRaid[] = [];
  const used = new Set<string>();
  for (const known of KNOWN_RAIDS) {
    const key = plain(known.zone);
    used.add(key);
    const done = byZone.get(key) ?? [];
    const bosses = known.bosses.map((name): GoalBoss => ({ name, killedAt: done.find((k) => sameBoss(k.name, name))?.at ?? null }));
    const killed = bosses.filter((b) => b.killedAt !== null).length;
    if (opts.hideUntouched && killed === 0) continue;
    out.push({ zone: known.zone, bosses, killed, total: bosses.length, known: true });
  }
  for (const [key, done] of byZone) {
    if (used.has(key) || done.length === 0) continue;
    const zone = raids.find((r) => plain(r.zone) === key)?.zone ?? key;
    out.push({ zone, bosses: done.map((k) => ({ name: k.name, killedAt: k.at })), killed: done.length, total: done.length, known: false });
  }
  return { raids: out, killed: out.reduce((n, r) => n + r.killed, 0), total: out.reduce((n, r) => n + (r.known ? r.total : 0), 0) };
}
