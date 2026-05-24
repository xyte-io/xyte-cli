import type { TuiArrowHandleResult, TuiArrowKey, TuiPaneId } from './types';

export interface ListTableLike {
  selected?: number;
  select(index: number): void;
  setData?(rows: string[][]): void;
}

export interface ScrollBoxLike {
  scroll?(amount: number): void;
}

export interface SelectionSyncState {
  syncing: boolean;
  name?: string;
  onLog?: (event: string, data?: Record<string, unknown>) => void;
}

function withSelectionSyncGuard(state: SelectionSyncState | undefined, fn: () => void): void {
  if (!state) {
    fn();
    return;
  }

  const previous = state.syncing;
  state.syncing = true;
  state.onLog?.('selection.sync.guard.start', {
    name: state.name
  });
  try {
    fn();
  } finally {
    state.syncing = previous;
    state.onLog?.('selection.sync.guard.end', {
      name: state.name
    });
  }
}

export function setListTableData(
  list: ListTableLike | undefined,
  rows: Array<Array<string | number>>,
  state?: SelectionSyncState
): void {
  if (!list) {
    return;
  }
  withSelectionSyncGuard(state, () => {
    list.setData?.(rows.map((row) => row.map(String)));
  });
}

export function syncListSelection(
  list: ListTableLike | undefined,
  rowIndex: number,
  state: SelectionSyncState
): void {
  if (!list) {
    return;
  }
  if (state.syncing) {
    return;
  }

  const target = Math.max(0, rowIndex) + 1;
  const currentSelected = list.selected;
  if (currentSelected === target) {
    return;
  }

  state.syncing = true;
  state.onLog?.('selection.sync.start', {
    name: state.name,
    target
  });
  try {
    list.select(target);
  } finally {
    state.syncing = false;
    state.onLog?.('selection.sync.end', {
      name: state.name,
      target
    });
  }
}

export function shouldIgnoreSelectEvent(state: SelectionSyncState): boolean {
  if (!state.syncing) {
    return false;
  }
  state.onLog?.('selection.event.ignored', {
    name: state.name,
    programmatic: true
  });
  return true;
}

export function cyclePane(panes: TuiPaneId[], activePane: TuiPaneId, key: TuiArrowKey): TuiPaneId {
  if (!panes.length) {
    return activePane;
  }
  const current = Math.max(0, panes.indexOf(activePane));
  const delta = key === 'left' ? -1 : key === 'right' ? 1 : 0;
  if (!delta) {
    return activePane;
  }
  const next = (current + delta + panes.length) % panes.length;
  return panes[next];
}

export function movePaneWithBoundary(
  panes: TuiPaneId[],
  activePane: TuiPaneId,
  direction: 'left' | 'right'
): { pane: TuiPaneId; boundary: boolean } {
  if (!panes.length) {
    return { pane: activePane, boundary: true };
  }
  const current = Math.max(0, panes.indexOf(activePane));
  if (direction === 'left') {
    if (current <= 0) {
      return { pane: panes[0], boundary: true };
    }
    return { pane: panes[current - 1], boundary: false };
  }

  if (current >= panes.length - 1) {
    return { pane: panes[panes.length - 1], boundary: true };
  }
  return { pane: panes[current + 1], boundary: false };
}

export function moveTableSelection(args: {
  table?: ListTableLike;
  index: number;
  delta: number;
  totalRows: number;
  selectionSync?: SelectionSyncState;
}): number {
  const { table, index, delta, totalRows, selectionSync } = args;
  if (totalRows <= 0) {
    return 0;
  }
  const next = Math.max(0, Math.min(index + delta, totalRows - 1));
  if (selectionSync) {
    syncListSelection(table, next, selectionSync);
  } else {
    table?.select(next + 1);
  }
  return next;
}

export function scrollBox(box: ScrollBoxLike | undefined, delta: number): void {
  if (!box || delta === 0) {
    return;
  }
  const scroll = box.scroll;
  if (typeof scroll !== 'function') {
    return;
  }
  scroll.call(box, delta);
}

export function clampIndex(index: number, totalRows: number): number {
  if (totalRows <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, totalRows - 1));
}

/**
 * Handles left/right pane navigation shared across all TUI screens.
 * Returns 'handled' or 'boundary' when the key is left/right, null otherwise.
 * The onNavigate callback is responsible for updating activePane and calling focusPane().
 */
export function handleHorizontalArrow(
  key: TuiArrowKey,
  panes: TuiPaneId[],
  activePane: TuiPaneId,
  onNavigate: (newPane: TuiPaneId) => void
): TuiArrowHandleResult | null {
  if (key !== 'left' && key !== 'right') {
    return null;
  }
  const next = movePaneWithBoundary(panes, activePane, key);
  if (next.boundary) {
    return 'boundary';
  }
  onNavigate(next.pane);
  return 'handled';
}
