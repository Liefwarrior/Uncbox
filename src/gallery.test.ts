import { describe, expect, it } from 'vitest';
import { allTags, filterGallery, type GalleryEntry } from './gallery';

const entry = (over: Partial<GalleryEntry>): GalleryEntry => ({
  id: 'x',
  name: 'X',
  author: 'Someone',
  description: '',
  base: 'desk',
  tags: [],
  preview: '',
  updated: '',
  ...over,
});

const list = [
  entry({ id: 'nuzlocke-run', name: 'Nuzlocke run', author: 'Uncbox', description: 'Deaths and badges', base: 'pokemon', tags: ['nuzlocke', 'challenge'] }),
  entry({ id: 'ranked-grind', name: 'Ranked grind', author: 'Uncbox', description: 'Climb with breaks', base: 'smite2', tags: ['ranked', 'challenge'] }),
  entry({ id: 'cozy-desk', name: 'Cozy desk', author: 'Mira', description: 'A calm desk', base: 'desk', tags: ['relax'] }),
];
const gameName = (b: string) => ({ pokemon: 'Pokémon', smite2: 'SMITE 2', desk: 'Desk' })[b as 'desk'] ?? b;

describe('filterGallery', () => {
  const ids = (q: string, tag: string | null = null) => filterGallery(list, q, tag, gameName).map((e) => e.id);

  it('shows everything with nothing typed', () => {
    expect(ids('')).toEqual(['nuzlocke-run', 'ranked-grind', 'cozy-desk']);
    expect(ids('   ')).toHaveLength(3);
  });

  it('finds words in the name, author, description, tags and game', () => {
    expect(ids('nuzlocke')).toEqual(['nuzlocke-run']);
    expect(ids('mira')).toEqual(['cozy-desk']);
    expect(ids('climb')).toEqual(['ranked-grind']);
    expect(ids('relax')).toEqual(['cozy-desk']);
    expect(ids('pokémon')).toEqual(['nuzlocke-run']);
    expect(ids('smite 2')).toEqual(['ranked-grind']);
  });

  it('wants every word, in any order, ignoring case', () => {
    expect(ids('GRIND ranked')).toEqual(['ranked-grind']);
    expect(ids('uncbox calm')).toEqual([]);
  });

  it('narrows to a tag, together with the words', () => {
    expect(ids('', 'challenge')).toEqual(['nuzlocke-run', 'ranked-grind']);
    expect(ids('ranked', 'challenge')).toEqual(['ranked-grind']);
    expect(ids('desk', 'challenge')).toEqual([]);
  });
});

describe('allTags', () => {
  it('lists each tag once, the most used first', () => {
    expect(allTags(list)).toEqual(['challenge', 'nuzlocke', 'ranked', 'relax']);
  });
});
