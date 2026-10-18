import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Digits } from './Digits';
import { formatDuration } from './RunPanel';

describe('Digits', () => {
  it('puts every digit in its own fixed-width cell and keeps separators apart', () => {
    const html = renderToStaticMarkup(<Digits value="1:05" className="timer" />);
    expect(html).toBe(
      '<span class="digits timer" aria-label="1:05">' +
        '<span class="digits__d digits__d--1" aria-hidden="true">1</span>' +
        '<span class="digits__s" aria-hidden="true">:</span>' +
        '<span class="digits__d digits__d--0" aria-hidden="true">0</span>' +
        '<span class="digits__d digits__d--5" aria-hidden="true">5</span>' +
        '</span>',
    );
  });
});

describe('formatDuration', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });

  it('adds a day count past 24 hours', () => {
    expect(formatDuration(90_061_000)).toBe('1d 01:01:01');
  });

  it('never goes negative', () => {
    expect(formatDuration(-5000)).toBe('0:00:00');
  });
});
