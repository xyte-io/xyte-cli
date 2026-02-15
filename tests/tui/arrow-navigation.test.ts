import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cyclePane, moveTableSelection, scrollBox } from '../../src/tui/navigation';
import { SCREEN_PANE_CONFIG } from '../../src/tui/panes';

describe('pane-focus arrow navigation', () => {
  it('defines pane configuration for every screen', () => {
    const screens = Object.keys(SCREEN_PANE_CONFIG);
    expect(screens.sort()).toEqual(['config', 'copilot', 'dashboard', 'devices', 'incidents', 'setup', 'spaces', 'tickets'].sort());

    for (const [screenId, config] of Object.entries(SCREEN_PANE_CONFIG)) {
      expect(config.panes.length).toBeGreaterThan(0);
      expect(config.panes).toContain(config.defaultPane);
      expect(typeof screenId).toBe('string');
    }
  });

  it('cycles panes with left/right and wraps around', () => {
    const panes = ['a', 'b', 'c'];
    expect(cyclePane(panes, 'a', 'right')).toBe('b');
    expect(cyclePane(panes, 'c', 'right')).toBe('a');
    expect(cyclePane(panes, 'a', 'left')).toBe('c');
    expect(cyclePane(panes, 'b', 'left')).toBe('a');
  });

  it('moves list selection by exactly one row per arrow press for all list screens', () => {
    const listScreens = ['setup', 'config', 'spaces', 'devices', 'incidents', 'tickets'] as const;
    for (const screenId of listScreens) {
      const list = {
        selected: 0,
        select(index: number) {
          this.selected = index;
        }
      };
      let index = 2;
      index = moveTableSelection({
        table: list as any,
        index,
        delta: 1,
        totalRows: 10
      });
      expect(index, `${screenId} should increment by one`).toBe(3);
      expect(list.selected, `${screenId} list select index should match +1 header offset`).toBe(4);

      index = moveTableSelection({
        table: list as any,
        index,
        delta: -1,
        totalRows: 10
      });
      expect(index, `${screenId} should decrement by one`).toBe(2);
      expect(list.selected, `${screenId} list select index should match +1 header offset`).toBe(3);
    }
  });

  it('disables native keys on non-input screen widgets to avoid double arrow handling', () => {
    const root = process.cwd();
    const nonInputScreens = ['setup', 'config', 'spaces', 'devices', 'incidents', 'tickets', 'dashboard'] as const;
    for (const name of nonInputScreens) {
      const source = readFileSync(join(root, 'src', 'tui', 'screens', `${name}.ts`), 'utf8');
      expect(source).not.toMatch(/keys:\s*true/);
    }

    const copilotSource = readFileSync(join(root, 'src', 'tui', 'screens', 'copilot.ts'), 'utf8');
    const matches = copilotSource.match(/keys:\s*true/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('does not throw when scrolling non-scrollable box widgets', () => {
    expect(() => scrollBox({} as any, 1)).not.toThrow();
  });
});
