import { describe, expect, it } from 'vitest';

import { ellipsizeEnd, ellipsizeMiddle, fitCell, formatBoolTag, sanitizePrintable, shortId } from '../../src/tui/table-format';

describe('table-format helpers', () => {
  it('applies middle ellipsis deterministically', () => {
    expect(ellipsizeMiddle('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcde…wxyz');
    expect(ellipsizeMiddle('abc', 10)).toBe('abc');
  });

  it('applies end ellipsis deterministically', () => {
    expect(ellipsizeEnd('abcdefghijklmnopqrstuvwxyz', 8)).toBe('abcdefg…');
    expect(ellipsizeEnd('abc', 8)).toBe('abc');
  });

  it('handles very short widths safely', () => {
    expect(ellipsizeMiddle('abcdef', 1)).toBe('…');
    expect(ellipsizeEnd('abcdef', 0)).toBe('');
    expect(fitCell('abcdef', 2, 'middle')).toBe('a…');
  });

  it('sanitizes nullish and control characters', () => {
    expect(sanitizePrintable(undefined)).toBe('n/a');
    expect(sanitizePrintable(null)).toBe('n/a');
    expect(sanitizePrintable('ab\n\tcd\u0000ef')).toBe('ab cdef');
  });

  it('formats boolean tags and short ids', () => {
    expect(formatBoolTag(true)).toBe('yes');
    expect(formatBoolTag('active')).toBe('yes');
    expect(formatBoolTag('no')).toBe('no');
    expect(shortId('1234567890abcdef', { head: 4, tail: 3 })).toBe('1234…def');
  });
});

