import { describe, expect, it } from 'vitest';

import { GLOBAL_KEYMAP, SCREEN_ACTION_KEYMAP } from '../../src/tui/keymap';

describe('tui keymaps', () => {
  it('defines required global shortcuts', () => {
    const keys = GLOBAL_KEYMAP.map((item) => item.keys);
    expect(keys).toContain('Tab / Shift+Tab');
    expect(keys).toContain('1-7');
    expect(keys).toContain('←/→');
    expect(keys).toContain('↑/↓');
    expect(keys).toContain('Enter');
    expect(keys).toContain('a');
    expect(keys).toContain('f');
    expect(keys).toContain('[ / ]');
    expect(keys).toContain('p');
    expect(keys).toContain('u');
    expect(keys).toContain('g');
    expect(keys).toContain('d');
    expect(keys).toContain('s');
    expect(keys).toContain('v');
    expect(keys).toContain('i');
    expect(keys).toContain('t');
    expect(keys).toContain('q');
  });

  it('defines workflow action shortcuts', () => {
    const actions = SCREEN_ACTION_KEYMAP.map((item) => item.keys);
    expect(actions).toContain('Incidents: a/f/[ ]/p/');
    expect(actions).toContain('Tickets: a/f/R/rr/[ ]/p');
  });
});
