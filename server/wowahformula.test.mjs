import { describe, expect, it } from 'vitest';
import { checkFormula, compile, evalFormula, formulaVariables, parseFormula, tokenize } from './wowahformula.mjs';
import { formatMoney, parseMoney } from './money.mjs';

const vars = { dbmarket: 1200, dbminbuyout: 1000, dbhistorical: 1100, avgsell: 1150, vendorsell: 50, crafting: 800 };
const value = (formula, v = vars) => {
  const r = evalFormula(formula, v);
  expect(r.ok, r.error).toBe(true);
  return r.value;
};
const error = (formula) => {
  const r = evalFormula(formula, vars);
  expect(r.ok).toBe(false);
  return r.error;
};

describe('money', () => {
  it('formats copper and reads it back', () => {
    expect(formatMoney(123456)).toBe('12g 34s 56c');
    expect(formatMoney(120000)).toBe('12g');
    expect(formatMoney(0)).toBe('0c');
    expect(formatMoney(-150)).toBe('-1s 50c');
    expect(formatMoney(NaN)).toBe('-');
    expect(parseMoney('12g 34s 56c')).toBe(123456);
    expect(parseMoney('1g50s')).toBe(15000);
    expect(parseMoney('250')).toBe(250);
    expect(parseMoney('lots')).toBeNull();
    expect(parseMoney('')).toBeNull();
    for (const n of [0, 1, 99, 100, 12345, 987654321]) expect(parseMoney(formatMoney(n))).toBe(n);
  });
});

describe('the price formula language', () => {
  it('reads numbers and money literals', () => {
    expect(value('42')).toBe(42);
    expect(value('1g50s')).toBe(15000);
    expect(value('75s')).toBe(7500);
    expect(value('12c')).toBe(12);
    expect(value('1g2s3c')).toBe(10203);
    expect(value('1.5g')).toBe(15000);
    expect(value('2.5')).toBe(3); // whole copper at the end
  });

  it('uses the prices of the item', () => {
    expect(value('dbmarket')).toBe(1200);
    expect(value('DBMinBuyout')).toBe(1000);
    expect(value('dbhistorical + avgsell')).toBe(2250);
    expect(value('vendorsell * 3')).toBe(150);
    expect(value('crafting')).toBe(800);
  });

  it('does arithmetic with the usual precedence, brackets and minus', () => {
    expect(value('2 + 3 * 4')).toBe(14);
    expect(value('(2 + 3) * 4')).toBe(20);
    expect(value('10 - 4 - 3')).toBe(3);
    expect(value('100 / 4 / 5')).toBe(5);
    expect(value('-5 + 8')).toBe(3);
    expect(value('3 - -2')).toBe(5);
    expect(value('dbminbuyout - 1s')).toBe(900);
  });

  it('multiplies by a percentage written in front of a value', () => {
    expect(value('90% dbmarket')).toBe(1080);
    expect(value('50% (dbmarket + dbminbuyout)')).toBe(1100);
    expect(value('150%')).toBe(2); // 1.5 alone is just the number 1.5
    expect(value('200% * 3s')).toBe(600);
    expect(value('max(vendorsell, 85% dbmarket)')).toBe(1020);
  });

  it('has min, max, avg, round, floor, ceil and abs', () => {
    expect(value('min(5, 3, 9)')).toBe(3);
    expect(value('max(5, 3, 9)')).toBe(9);
    expect(value('avg(10, 20, 60)')).toBe(30);
    expect(value('round(2.5) + floor(2.9) + ceil(2.1) + abs(-4)')).toBe(3 + 2 + 3 + 4);
    expect(value('max(dbminbuyout - 1c, vendorsell)')).toBe(999);
  });

  it('first() picks the first price that exists', () => {
    const noMarket = { dbminbuyout: 1000 };
    expect(value('first(dbmarket, dbminbuyout, 5)', noMarket)).toBe(1000);
    expect(value('first(dbmarket, dbhistorical, 5c)', noMarket)).toBe(5);
    expect(value('first(dbmarket, 1)', vars)).toBe(1200);
    expect(evalFormula('first(dbmarket, dbhistorical)', noMarket)).toEqual({ ok: true, value: null });
  });

  it('is invalid (null), not wrong, when an item has no data for a price', () => {
    const none = {};
    expect(evalFormula('dbmarket', none)).toEqual({ ok: true, value: null });
    expect(evalFormula('90% dbmarket', none).value).toBeNull();
    expect(evalFormula('min(dbmarket, 5)', none).value).toBeNull();
    expect(evalFormula('max(first(vendorsell, 0), 5)', none).value).toBe(5);
    expect(evalFormula('5 / 0', none).value).toBeNull();
    expect(evalFormula('dbmarket', { dbmarket: NaN }).value).toBeNull();
  });

  it('knows which prices a formula uses', () => {
    expect([...formulaVariables(parseFormula('max(vendorsell, 85% dbmarket) - dbminbuyout'))].sort()).toEqual(['dbmarket', 'dbminbuyout', 'vendorsell']);
  });

  it.each([
    ['', 'The formula is empty'],
    ['   ', 'The formula is empty'],
    ['1 +', 'The formula ends too soon (at 4)'],
    ['(1 + 2', 'Expected ")" (at 7)'],
    ['1 + 2)', 'Unmatched ")" (at 6)'],
    ['foo', 'Unknown price "foo" (at 1)'],
    ['dbmarket + bar', 'Unknown price "bar" (at 12)'],
    ['nope(1)', 'Unknown function "nope" (at 1)'],
    ['min', 'min needs brackets, like min(...) (at 1)'],
    ['abs(1, 2)', 'abs() takes 1 value, not 2 (at 1)'],
    ['min()', 'min() takes 1 to 20 values, not 0 (at 1)'],
    ['1 $ 2', 'Unexpected "$" (at 3)'],
    ['12x', '"12x" isn\'t a number (at 1)'],
    ['1 2', 'Expected + - * / or the end of the formula (at 3)'],
    ['min(1 2)', 'Expected ")" or "," (at 7)'],
    ['* 3', 'Unexpected "*" (at 1)'],
  ])('explains a mistake: %j', (formula, message) => {
    expect(error(formula)).toBe(message);
  });

  it('refuses very long and very deep formulas', () => {
    expect(error('1+'.repeat(300))).toMatch(/longer than 500/);
    expect(error(`${'('.repeat(40)}1${')'.repeat(40)}`)).toMatch(/nests too deeply/);
    expect(checkFormula('((((((((1))))))))')).toBeNull();
  });

  it('never evaluates code', () => {
    for (const attack of ['process.exit()', 'constructor', '__proto__', 'this', 'globalThis.x', 'dbmarket.toString()', '`1`', "'a'", '1; 2', '[1]', 'x => x']) {
      expect(evalFormula(attack, vars).ok, attack).toBe(false);
    }
    // A variable table with inherited names does not leak either.
    expect(evalFormula('dbmarket', Object.create({ dbmarket: 5 })).value).toBeNull();
  });

  it('tokenizes into positions', () => {
    expect(tokenize('90% dbmarket').map((t) => t.type)).toEqual(['pct', 'name', 'end']);
    expect(tokenize('1g50s - 2')[0]).toMatchObject({ type: 'num', value: 15000, money: true });
  });

  it('remembers parsed formulas', () => {
    expect(compile('dbmarket')).toBe(compile('dbmarket'));
  });
});
