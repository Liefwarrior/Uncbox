import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch, fuzzyScore } from './fuzzy';

const best = (query: string, texts: string[]) => fuzzyFilter(query, texts, (t) => t).map((r) => r.item);

describe('fuzzyMatch', () => {
  it('needs the letters in order', () => {
    expect(fuzzyScore('stm', 'Stream mode')).not.toBeNull();
    expect(fuzzyScore('mts', 'Stream mode')).toBeNull();
    expect(fuzzyScore('xyz', 'Stream mode')).toBeNull();
    expect(fuzzyScore('aaa', 'a')).toBeNull();
  });

  it('matches everything for an empty query', () => {
    expect(fuzzyMatch('', 'Anything')).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch('   ', 'Anything')).toEqual({ score: 0, positions: [] });
  });

  it('ignores case', () => {
    expect(fuzzyScore('STREAM', 'stream mode')).not.toBeNull();
    expect(fuzzyScore('stream', 'STREAM MODE')).not.toBeNull();
    expect(fuzzyMatch('obs', 'Switch OBS to Game')?.positions).toEqual([7, 8, 9]);
  });

  it('prefers the same case when nothing else differs', () => {
    expect(fuzzyScore('OBS', 'OBS')!).toBeGreaterThan(fuzzyScore('OBS', 'obs')!);
  });

  it('ranks a prefix and a whole word above a scattered match', () => {
    expect(best('clip', ['Copy lines in pane', 'Open the clips folder', 'Save a clip'])).toEqual(['Save a clip', 'Open the clips folder', 'Copy lines in pane']);
    expect(best('stream', ['Upstream', 'Toggle stream mode'])[0]).toBe('Toggle stream mode');
  });

  it('prefers letters at the start of a word', () => {
    // Both contain "wi", but only one has it where a word begins.
    expect(best('wi', ['Twitch stream', 'Add widget'])[0]).toBe('Add widget');
  });

  it('prefers letters next to each other', () => {
    expect(best('plan', ['xpxlxaxn', 'xplanx'])[0]).toBe('xplanx');
  });

  it('matches acronyms of the words', () => {
    expect(best('ow', ['Show rows', 'Open web widget'])[0]).toBe('Open web widget');
    expect(best('tsm', ['Toggle stream mode', 'Tasmania'])[0]).toBe('Toggle stream mode');
    expect(fuzzyMatch('tsm', 'Toggle stream mode')?.positions).toEqual([0, 7, 14]);
  });

  it('counts a capital after a lower case letter as a word start', () => {
    expect(fuzzyMatch('gt', 'getThing')?.positions).toEqual([0, 3]);
  });

  it('matches each word of the query on its own, in any order', () => {
    expect(fuzzyScore('mode stream', 'Toggle stream mode')).not.toBeNull();
    expect(fuzzyScore('mode xyz', 'Toggle stream mode')).toBeNull();
  });

  it('puts an exact title first, and a shorter title before a longer one', () => {
    expect(best('clock', ['Add widget: Clock', 'Clock'])[0]).toBe('Clock');
    expect(best('add', ['Add widget: Clock', 'Add'])[0]).toBe('Add');
  });

  it('reports where it matched', () => {
    expect(fuzzyMatch('ab', 'xaxb')?.positions).toEqual([1, 3]);
  });

  it('keeps the original order for equal scores', () => {
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect(fuzzyFilter('x', items, () => 'xx').map((r) => r.item.n)).toEqual([1, 2, 3]);
  });
});
