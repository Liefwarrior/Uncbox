import { describe, expect, it } from 'vitest';
import { csvCell, csvDate, csvDateTime, toCsv } from './csv';

describe('csvCell', () => {
  it('leaves plain text and numbers alone', () => {
    expect(csvCell('Lief')).toBe('Lief');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes anything with a comma, a quote or a line break, doubling the quotes', () => {
    expect(csvCell('Thunderfury, Blessed Blade of the Windseeker')).toBe('"Thunderfury, Blessed Blade of the Windseeker"');
    expect(csvCell('The "Dragon" Slayer')).toBe('"The ""Dragon"" Slayer"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
  });

  it('keeps accents and other unicode as they are', () => {
    expect(csvCell('Zoë')).toBe('Zoë');
    expect(csvCell('Ñandú, el Bravo')).toBe('"Ñandú, el Bravo"');
    expect(csvCell('龍')).toBe('龍');
  });

  it('makes text a spreadsheet would run as a formula plain, but not a number', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('@home')).toBe("'@home");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('+evil')).toBe("'+evil");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('toCsv', () => {
  it('writes a line per row, ending in CRLF', () => {
    expect(toCsv([['Name', 'Item'], ['Zoë', 'Band, of Accuria']])).toBe('Name,Item\r\nZoë,"Band, of Accuria"\r\n');
  });

  it('writes empty cells for missing values and keeps the columns', () => {
    expect(toCsv([['a', null, 'c'], [undefined, 'b', 3]])).toBe('a,,c\r\n,b,3\r\n');
  });
});

describe('dates', () => {
  it('writes this PC’s date and time with zeros in front', () => {
    const t = new Date(2026, 0, 5, 7, 4).getTime();
    expect(csvDate(t)).toBe('2026-01-05');
    expect(csvDateTime(t)).toBe('2026-01-05 07:04');
  });
});
