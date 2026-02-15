import { describe, expect, it } from 'vitest';

import { nextTab, TAB_ORDER } from '../../src/tui/tabs';
import { movePaneWithBoundary } from '../../src/tui/navigation';

describe('tab arrow navigation', () => {
  it('moves to next and previous tabs with wraparound', () => {
    expect(nextTab('setup', 'left')).toBe('copilot');
    expect(nextTab('setup', 'right')).toBe('config');
    expect(nextTab('copilot', 'right')).toBe('setup');
  });

  it('reports pane boundaries for tab-switch escalation', () => {
    const panes = ['a', 'b', 'c'];
    expect(movePaneWithBoundary(panes, 'a', 'left')).toEqual({ pane: 'a', boundary: true });
    expect(movePaneWithBoundary(panes, 'c', 'right')).toEqual({ pane: 'c', boundary: true });
    expect(movePaneWithBoundary(panes, 'b', 'left')).toEqual({ pane: 'a', boundary: false });
    expect(movePaneWithBoundary(panes, 'b', 'right')).toEqual({ pane: 'c', boundary: false });
  });

  it('keeps tab order aligned with screen registry ordering', () => {
    expect(TAB_ORDER).toEqual(['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets', 'copilot']);
  });
});
