import { describe, expect, it } from 'vitest';

import { paginateTableRowsByHeight, shouldBreakBeforeTableRow } from '../src/workflows/report/pdf-table';

describe('report table pagination', () => {
  it('avoids single-row continuation pages when two rows remain', () => {
    const pages = paginateTableRowsByHeight({
      rowHeights: [28, 28, 28, 30, 30],
      firstPageHeight: 118,
      continuationPageHeight: 118
    });

    expect(pages).toEqual([
      [0, 1, 2],
      [3, 4]
    ]);
  });

  it('keeps pagination stable with variable row heights', () => {
    const pages = paginateTableRowsByHeight({
      rowHeights: [32, 21, 45, 26, 18, 33, 27, 29],
      firstPageHeight: 110,
      continuationPageHeight: 96
    });

    expect(pages).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7]
    ]);
  });

  it('breaks before a row when it would orphan the final row', () => {
    expect(
      shouldBreakBeforeTableRow({
        availableHeight: 34,
        currentRowHeight: 30,
        nextRowHeight: 30,
        remainingRows: 2,
        rowsOnPage: 3
      })
    ).toBe(true);
  });

  it('forces progress when a row is larger than page capacity', () => {
    const pages = paginateTableRowsByHeight({
      rowHeights: [150, 20],
      firstPageHeight: 100,
      continuationPageHeight: 100
    });

    expect(pages).toEqual([[0], [1]]);
  });
});
