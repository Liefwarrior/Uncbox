import { describe, expect, it } from 'vitest';
import { parseWords } from './ocr.mjs';

describe('parseWords', () => {
  it('reads the helper’s lines and words', () => {
    const raw = '[{"text":"ORDER","words":[["ORDER",54,268,60,12]]}]';
    expect(parseWords(raw)).toEqual([{ text: 'ORDER', words: [['ORDER', 54, 268, 60, 12]] }]);
  });

  it('keeps a picture’s other lines when an icon was read as a control character', () => {
    // A real reading: the bell comes through unescaped, which is not valid JSON as it stands.
    const raw = '[{"text":"A","words":[["A",1,2,3,4]]},{"text":"\u0007 Kali","words":[["\u0007",5,6,7,8],["Kali",9,10,11,12]]}]';
    const lines = parseWords(raw);
    expect(lines.map((l) => l.text)).toEqual(['A', ' Kali']);
    expect(lines[1].words[1][0]).toBe('Kali');
  });

  it('turns one line that PowerShell unwrapped back into a list, and nonsense into nothing', () => {
    expect(parseWords('{"text":"Hi","words":["Hi",1,2,3,4]}')).toEqual([{ text: 'Hi', words: [['Hi', 1, 2, 3, 4]] }]);
    expect(parseWords('not json')).toEqual([]);
    expect(parseWords('')).toEqual([]);
  });
});
