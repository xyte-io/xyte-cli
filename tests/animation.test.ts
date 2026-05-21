import { describe, expect, it } from 'vitest';

import { isMotionEnabled, pulseChar, startupFrames } from '../src/tui/animation';

describe('pulseChar', () => {
  it('returns a character for any phase', () => {
    for (let i = 0; i < 10; i++) {
      expect(typeof pulseChar(i)).toBe('string');
      expect(pulseChar(i).length).toBe(1);
    }
  });

  it('cycles through characters', () => {
    expect(pulseChar(0)).not.toBe(pulseChar(1));
  });

  it('handles negative phases', () => {
    expect(typeof pulseChar(-3)).toBe('string');
  });
});

describe('isMotionEnabled', () => {
  it('defaults to true for interactive mode', () => {
    expect(isMotionEnabled({})).toBe(true);
  });

  it('returns false for headless mode', () => {
    expect(isMotionEnabled({ headless: true })).toBe(false);
  });

  it('respects explicit motion setting over headless', () => {
    expect(isMotionEnabled({ headless: true, explicitMotion: true })).toBe(true);
    expect(isMotionEnabled({ headless: false, explicitMotion: false })).toBe(false);
  });
});

describe('startupFrames', () => {
  it('returns non-empty array of frames', () => {
    const frames = startupFrames();
    expect(frames.length).toBeGreaterThan(0);
  });

  it('each frame has banner, status, and title', () => {
    const frames = startupFrames();
    for (const frame of frames) {
      expect(typeof frame.banner).toBe('string');
      expect(typeof frame.status).toBe('string');
      expect(typeof frame.title).toBe('string');
    }
  });
});
