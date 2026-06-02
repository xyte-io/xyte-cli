import type PDFKit from 'pdfkit';

import { PDF_LAYOUT, drawSectionTitle, ensurePageSpace, startReportPage, type PdfRenderContext } from './pdf-layout';
import { REPORT_THEME } from './theme';

interface TableColumn {
  header: string;
  width: number;
  align?: 'left' | 'center' | 'right';
  wrap?: boolean;
}

interface ShouldBreakBeforeTableRowArgs {
  availableHeight: number;
  currentRowHeight: number;
  nextRowHeight: number;
  remainingRows: number;
  rowsOnPage: number;
}

export function shouldBreakBeforeTableRow(args: ShouldBreakBeforeTableRowArgs): boolean {
  if (args.rowsOnPage < 1) {
    return false;
  }
  if (args.remainingRows !== 2) {
    return false;
  }
  if (args.currentRowHeight > args.availableHeight) {
    return false;
  }
  return args.currentRowHeight + args.nextRowHeight > args.availableHeight;
}

interface PaginateTableRowsByHeightArgs {
  rowHeights: number[];
  firstPageHeight: number;
  continuationPageHeight: number;
}

export function paginateTableRowsByHeight(args: PaginateTableRowsByHeightArgs): number[][] {
  const pages: number[][] = [];
  if (!args.rowHeights.length) {
    return pages;
  }

  let rowIndex = 0;
  let pageIndex = 0;
  while (rowIndex < args.rowHeights.length) {
    const pageCapacity = Math.max(1, pageIndex === 0 ? args.firstPageHeight : args.continuationPageHeight);
    let consumed = 0;
    const pageRows: number[] = [];

    while (rowIndex < args.rowHeights.length) {
      const currentHeight = args.rowHeights[rowIndex];
      const remainingRows = args.rowHeights.length - rowIndex;
      const nextHeight = remainingRows > 1 ? args.rowHeights[rowIndex + 1] : 0;
      const available = pageCapacity - consumed;

      if (
        shouldBreakBeforeTableRow({
          availableHeight: available,
          currentRowHeight: currentHeight,
          nextRowHeight: nextHeight,
          remainingRows,
          rowsOnPage: pageRows.length
        })
      ) {
        break;
      }

      const fits = currentHeight <= available;
      if (!fits && pageRows.length > 0) {
        break;
      }

      pageRows.push(rowIndex);
      consumed += currentHeight;
      rowIndex += 1;

      if (!fits) {
        break;
      }
    }

    if (!pageRows.length) {
      pageRows.push(rowIndex);
      rowIndex += 1;
    }

    pages.push(pageRows);
    pageIndex += 1;
  }

  return pages;
}

function normalizeColumns(columns: TableColumn[], availableWidth: number): TableColumn[] {
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  if (Math.abs(total - availableWidth) <= 1) {
    return columns.map((column) => ({ ...column }));
  }

  if (total > availableWidth) {
    const ratio = availableWidth / total;
    const resized = columns.map((column) => ({ ...column, width: Math.max(44, Math.floor(column.width * ratio)) }));
    const resizedTotal = resized.reduce((sum, column) => sum + column.width, 0);
    resized[0].width += availableWidth - resizedTotal;
    return resized;
  }

  const expanded = columns.map((column) => ({ ...column }));
  const flexIndex = expanded.findIndex((column) => column.wrap !== false);
  const target = flexIndex >= 0 ? flexIndex : 0;
  expanded[target].width += availableWidth - total;
  return expanded;
}

function tableWidth(columns: TableColumn[]): number {
  return columns.reduce((sum, column) => sum + column.width, 0);
}

function measureTableRowHeight(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  columns: TableColumn[],
  row: string[]
): number {
  doc.font(ctx.fonts.regular).fontSize(9.5);
  const lineHeight = doc.currentLineHeight();
  let maxTextHeight = lineHeight;

  row.forEach((cell, columnIndex) => {
    const column = columns[columnIndex];
    const innerWidth = Math.max(24, column.width - PDF_LAYOUT.tableCellPadLeft - PDF_LAYOUT.tableCellPadRight);
    if (column.wrap === false) {
      maxTextHeight = Math.max(maxTextHeight, lineHeight);
      return;
    }
    const measured = doc.heightOfString(cell, {
      width: innerWidth,
      align: column.align ?? 'left',
      lineGap: 0
    });
    maxTextHeight = Math.max(maxTextHeight, measured);
  });

  const rowHeight = maxTextHeight + PDF_LAYOUT.tableCellPadTop + PDF_LAYOUT.tableCellPadBottom;
  return Math.min(PDF_LAYOUT.tableRowMax, Math.max(PDF_LAYOUT.tableRowMin, rowHeight));
}

function drawHorizontalRule(doc: PDFKit.PDFDocument, x: number, y: number, width: number, thickness: number): void {
  doc.save();
  doc
    .moveTo(x, y)
    .lineTo(x + width, y)
    .lineWidth(thickness)
    .strokeColor(REPORT_THEME.border.default)
    .stroke();
  doc.restore();
}

function fitHeaderCellFontSize(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  text: string,
  innerWidth: number
): number {
  for (let size = 9; size >= 7; size -= 0.5) {
    doc.font(ctx.fonts.medium).fontSize(size);
    if (doc.widthOfString(text, { characterSpacing: 0.3 }) <= innerWidth) {
      return size;
    }
  }
  return 7;
}

function drawTableHeader(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, columns: TableColumn[]): void {
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = tableWidth(columns);

  doc.save();
  doc.roundedRect(x, y, width, PDF_LAYOUT.tableHeaderHeight, 10).fill(REPORT_THEME.surface.accent);
  doc.restore();
  drawHorizontalRule(doc, x, y + PDF_LAYOUT.tableHeaderHeight, width, 1.5);

  let cursorX = x;
  columns.forEach((column) => {
    const header = column.header.toUpperCase();
    const innerWidth = column.width - PDF_LAYOUT.tableCellPadLeft - PDF_LAYOUT.tableCellPadRight;
    const fontSize = fitHeaderCellFontSize(doc, ctx, header, innerWidth);
    doc
      .font(ctx.fonts.medium)
      .fontSize(fontSize)
      .fillColor(REPORT_THEME.accent.strong)
      .text(header, cursorX + PDF_LAYOUT.tableCellPadLeft, y + PDF_LAYOUT.tableCellPadTop, {
        width: innerWidth,
        align: column.align ?? 'left',
        lineBreak: false,
        ellipsis: false,
        characterSpacing: 0.3
      });
    cursorX += column.width;
  });

  doc.y = y + PDF_LAYOUT.tableHeaderHeight;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  columns: TableColumn[],
  row: string[],
  rowHeight: number,
  rowIndex: number,
  getCellTextColor?: (args: { rowIndex: number; columnIndex: number; value: string }) => string | undefined
): void {
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = tableWidth(columns);
  const fill = rowIndex % 2 === 0 ? REPORT_THEME.surface.page : REPORT_THEME.surface.subtleAlt;

  doc.save();
  doc.rect(x, y, width, rowHeight).fill(fill);
  doc.restore();
  drawHorizontalRule(doc, x, y + rowHeight, width, 1);

  let cursorX = x;
  columns.forEach((column, columnIndex) => {
    const value = row[columnIndex] ?? '';
    const customColor = getCellTextColor?.({ rowIndex, columnIndex, value });
    const wraps = column.wrap !== false;
    doc
      .font(ctx.fonts.regular)
      .fontSize(9.5)
      .fillColor(customColor ?? REPORT_THEME.text.primary)
      .text(value, cursorX + PDF_LAYOUT.tableCellPadLeft, y + PDF_LAYOUT.tableCellPadTop, {
        width: column.width - PDF_LAYOUT.tableCellPadLeft - PDF_LAYOUT.tableCellPadRight,
        height: rowHeight - PDF_LAYOUT.tableCellPadTop - PDF_LAYOUT.tableCellPadBottom,
        align: column.align ?? 'left',
        lineBreak: wraps,
        ellipsis: false,
        lineGap: 0
      });
    cursorX += column.width;
  });

  doc.y = y + rowHeight;
}

export function drawTable(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  args: {
    title: string;
    columns: TableColumn[];
    rows: string[][];
    emptyMessage?: string;
    getCellTextColor?: (args: { rowIndex: number; columnIndex: number; value: string }) => string | undefined;
  }
): void {
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columns = normalizeColumns(args.columns, availableWidth);

  if (!args.rows.length) {
    drawSectionTitle(doc, ctx, args.title);
    ensurePageSpace(doc, ctx, 30);
    doc
      .font(ctx.fonts.regular)
      .fontSize(10)
      .fillColor(REPORT_THEME.text.secondary)
      .text(args.emptyMessage ?? 'No data available.', {
        width: availableWidth
      });
    doc.y += PDF_LAYOUT.sectionGap;
    return;
  }

  const rowHeights = args.rows.map((row) => measureTableRowHeight(doc, ctx, columns, row));
  const firstRowHeight = rowHeights[0];
  drawSectionTitle(doc, ctx, args.title);
  ensurePageSpace(doc, ctx, PDF_LAYOUT.tableHeaderHeight + firstRowHeight);
  drawTableHeader(doc, ctx, columns);

  const bottom = doc.page.height - doc.page.margins.bottom - PDF_LAYOUT.footerHeight;
  const firstPageHeight = Math.max(1, Math.floor(bottom - doc.y));
  const headingBlockHeight =
    PDF_LAYOUT.sectionHeadingLineHeight +
    PDF_LAYOUT.sectionUnderlineGap +
    PDF_LAYOUT.sectionUnderlineThickness +
    PDF_LAYOUT.sectionContentGap;
  const continuationStartY = PDF_LAYOUT.contentTopContinuation + headingBlockHeight + PDF_LAYOUT.tableHeaderHeight;
  const continuationPageHeight = Math.max(1, Math.floor(bottom - continuationStartY));
  const pages = paginateTableRowsByHeight({
    rowHeights,
    firstPageHeight,
    continuationPageHeight
  });

  pages.forEach((pageRows, pageIndex) => {
    if (pageIndex > 0) {
      startReportPage(doc, ctx);
      drawSectionTitle(doc, ctx, args.title, { continued: true });
      drawTableHeader(doc, ctx, columns);
    }

    pageRows.forEach((rowIndex) => {
      drawTableRow(doc, ctx, columns, args.rows[rowIndex], rowHeights[rowIndex], rowIndex, args.getCellTextColor);
    });
  });

  doc.y += PDF_LAYOUT.sectionGap;
}
