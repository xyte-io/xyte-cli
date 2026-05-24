import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  moveTableSelection,
  setListTableData,
  shouldIgnoreSelectEvent,
  syncListSelection,
  type SelectionSyncState
} from '../../src/tui/navigation';

class MockList extends EventEmitter {
  selected = 0;

  select(index: number): void {
    this.selected = index;
    this.emit('select item', {}, index);
  }

  setData(_rows: unknown[]): void {
    this.select(1);
  }
}

describe('selection sync guard', () => {
  it('avoids recursive select->event loops during programmatic selection', () => {
    const list = new MockList();
    const events: string[] = [];
    const state: SelectionSyncState = {
      syncing: false,
      name: 'test-list',
      onLog(event) {
        events.push(event);
      }
    };

    let selectEvents = 0;
    list.on('select item', (_item, index) => {
      selectEvents += 1;
      if (shouldIgnoreSelectEvent(state)) {
        return;
      }
      syncListSelection(list as any, Math.max(0, index - 1), state);
    });

    syncListSelection(list as any, 0, state);

    expect(selectEvents).toBe(1);
    expect(list.selected).toBe(1);
    expect(events).toContain('selection.sync.start');
    expect(events).toContain('selection.event.ignored');
    expect(events).toContain('selection.sync.end');
  });

  it('keeps moveTableSelection deterministic when guarded sync is enabled', () => {
    const list = new MockList();
    const state: SelectionSyncState = { syncing: false };
    let selectEvents = 0;

    list.on('select item', () => {
      selectEvents += 1;
      if (shouldIgnoreSelectEvent(state)) {
        return;
      }
      syncListSelection(list as any, list.selected - 1, state);
    });

    const nextIndex = moveTableSelection({
      table: list as any,
      index: 0,
      delta: 1,
      totalRows: 5,
      selectionSync: state
    });

    expect(nextIndex).toBe(1);
    expect(list.selected).toBe(2);
    expect(selectEvents).toBe(1);
  });

  it('suppresses select events emitted by listtable.setData', () => {
    const list = new MockList();
    const state: SelectionSyncState = { syncing: false };
    let ignoredEvents = 0;
    let handledEvents = 0;

    list.on('select item', () => {
      if (shouldIgnoreSelectEvent(state)) {
        ignoredEvents += 1;
        return;
      }
      handledEvents += 1;
    });

    setListTableData(list as any, [['ID'], ['1']], state);

    expect(ignoredEvents).toBe(1);
    expect(handledEvents).toBe(0);
  });
});
