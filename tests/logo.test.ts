import { describe, expect, it } from 'vitest';

import { XYTE_LOGO_COMPACT, xyteLogoRevealFrames, xyteLogoText } from '../src/tui/assets/logo';

describe('xyteLogoText', () => {
  it('returns a multi-line string', () => {
    const text = xyteLogoText();
    expect(text.split('\n').length).toBe(5);
  });
});

describe('xyteLogoRevealFrames', () => {
  it('returns progressive reveal frames', () => {
    const frames = xyteLogoRevealFrames();
    expect(frames.length).toBe(5);
    expect(frames[0].split('\n').length).toBe(1);
    expect(frames[4].split('\n').length).toBe(5);
  });

  it('each frame builds on the previous', () => {
    const frames = xyteLogoRevealFrames();
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].startsWith(frames[i - 1])).toBe(true);
    }
  });
});

describe('XYTE_LOGO_COMPACT', () => {
  it('is the string XYTE', () => {
    expect(XYTE_LOGO_COMPACT).toBe('XYTE');
  });
});
