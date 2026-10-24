import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from './money';

describe('money', () => {
  it('formats copper as gold, silver and copper', () => {
    expect(formatMoney(123456)).toBe('12g 34s 56c');
    expect(formatMoney(120000)).toBe('12g');
    expect(formatMoney(120005)).toBe('12g 5c');
    expect(formatMoney(3400)).toBe('34s');
    expect(formatMoney(0)).toBe('0c');
    expect(formatMoney(-150)).toBe('-1s 50c');
    expect(formatMoney(99.6)).toBe('1s');
    expect(formatMoney(NaN)).toBe('-');
  });

  it('reads money back', () => {
    expect(parseMoney('12g 34s 56c')).toBe(123456);
    expect(parseMoney('1g50s')).toBe(15000);
    expect(parseMoney('75s')).toBe(7500);
    expect(parseMoney('250')).toBe(250);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    for (const n of [0, 1, 99, 100, 12345, 987654321]) expect(parseMoney(formatMoney(n))).toBe(n);
  });
});
