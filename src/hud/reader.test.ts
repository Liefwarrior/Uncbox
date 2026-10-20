import { describe, expect, it } from 'vitest';
import { cleanReading } from './reader';

describe('screen reader', () => {
  it('turns OCR text into numbers, fixing letters game fonts get mistaken for', () => {
    expect(cleanReading('1,234', true)).toBe('1234');
    expect(cleanReading('LV 17', true)).toBe('17');
    expect(cleanReading('l O5', true)).toBe('105');
    expect(cleanReading('  Ancient Hunt  ', false)).toBe('Ancient Hunt');
    expect(cleanReading('', true)).toBe('');
  });
});
