import type PDFKit from 'pdfkit';

import { PDF_LAYOUT, drawSectionTitle, ensurePageSpace, startReportPage, type PdfRenderContext } from './pdf-layout';
import { XYTE_PALETTE } from './theme';

export interface TableColumn {
  header: string;
  width: number;
  align?: 'left' | 'center' | 'right';
  wrap?: boolean;
}

function normalizeColumns(columns: TableColumn[], availableWidth: number): TableColumn[] {
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  if (Math.abs(total - availableWidth) <= 1) {
    return columns;
  }
  if (total > availableWidth) {
    const ratio = availableWidth / total;
    const scaled = columns.map((column) => ({ ...column, width: Math.floor(column.width * ratio) }));
    const scaledTotal = scaled.reduce((sum, column) => sum + column.width, 0);
    scaled[0].width += availableWidth - scaledTotal;
    return scaled;
  }
  const grown = columns.map((column) => ({ ...column }));
  const flexIndex = grown.findIndex((column) => column.wrap !== false);
  const target = flexIndex === -1 ? 0 : flexIndex;
  grown[target].width += availableWidth - total;
  return grown;
}

function measureTableRowHeight(doc: PDFKit.PDFDocument, columns: TableColumn[], row: string[]): number {
  doc.font('Helvetica').fontSize(PDF_LAYOUT.fontBody);
  const lineHeight = doc.currentLineHeight();
  let maxHeight = lineHeight;
  row.forEach((cell, index) => {
    const column = columns[index];
    const innerWidth = Math.max(20, column.width - PDF_LAYOUT.tableCellPadX * 2);
    if (column.wrap === false) {
      maxHeight = Math.max(maxHeight, lineHeight);
      return;
    }
    const measured = doc.heightOfString(cell, {
      width: innerWidth,
      align: column.align ?? 'left'
    });
    maxHeight = Math.max(maxHeight, measured);
  });
  const rowHeight = maxHeight + PDF_LAYOUT.tableCellPadY * 2;
  return Math.min(PDF_LAYOUT.tableRowMax, Math.max(PDF_LAYOUT.tableRowMin, rowHeight));
}

export function drawTable(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  args: {
    title: string;
    columns: TableColumn[];
    rows: string[][];
    emptyMessage?: string;
  }
): void {
  const tableLeft = doc.page.margins.left;
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columns = normalizeColumns(args.columns, availableWidth);
  const headerHeight = 24;
  const continuationTitle = `${args.title} (cont.)`;

  const drawHeader = () => {
    ensurePageSpace(doc, ctx, headerHeight + 6);
    const y = doc.y;
    let x = tableLeft;
    columns.forEach((column) => {
      doc.save();
      doc.rect(x, y, column.width, headerHeight).fillAndStroke(XYTE_PALETTE.mist, XYTE_PALETTE.borderStrong);
      doc.rect(x, y, column.width, 4).fill(ctx.windowFocus.accent);
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.ink700).text(column.header, x + PDF_LAYOUT.tableCellPadX, y + 6, {
        width: column.width - PDF_LAYOUT.tableCellPadX * 2,
        align: column.align ?? 'left',
        ellipsis: true
      });
      x += column.width;
    });
    doc.y = y + headerHeight;
  };

  if (!args.rows.length) {
    ensurePageSpace(doc, ctx, 32 + headerHeight);
    drawSectionTitle(doc, ctx, args.title);
    ensurePageSpace(doc, ctx, 24);
    doc.font('Helvetica').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.slate500).text(args.emptyMessage ?? 'No data available.', {
      width: availableWidth
    });
    doc.moveDown(0.5);
    return;
  }

  const firstRowHeight = measureTableRowHeight(doc, columns, args.rows[0]);
  ensurePageSpace(doc, ctx, 34 + headerHeight + firstRowHeight);
  drawSectionTitle(doc, ctx, args.title);
  drawHeader();

  args.rows.forEach((row, rowIndex) => {
    const rowHeight = measureTableRowHeight(doc, columns, row);
    const bottom = doc.page.height - doc.page.margins.bottom - PDF_LAYOUT.footerHeight - PDF_LAYOUT.spaceSm;
    if (doc.y + rowHeight > bottom) {
      startReportPage(doc, ctx);
      ensurePageSpace(doc, ctx, 34 + headerHeight + Math.min(rowHeight, 60));
      drawSectionTitle(doc, ctx, continuationTitle);
      drawHeader();
    }

    const y = doc.y;
    let x = tableLeft;
    const rowFill = rowIndex % 2 === 0 ? XYTE_PALETTE.paper : '#F9FCFF';
    row.forEach((cell, index) => {
      const column = columns[index];
      doc.save();
      doc.rect(x, y, column.width, rowHeight).fillAndStroke(rowFill, '#E1EAF4');
      doc.restore();
      doc.font('Helvetica').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.ink900).text(cell, x + PDF_LAYOUT.tableCellPadX, y + PDF_LAYOUT.tableCellPadY, {
        width: column.width - PDF_LAYOUT.tableCellPadX * 2,
        height: rowHeight - PDF_LAYOUT.tableCellPadY * 2,
        align: column.align ?? 'left',
        lineBreak: column.wrap !== false,
        ellipsis: column.wrap === false
      });
      x += column.width;
    });
    doc.y = y + rowHeight;
  });

  doc.moveDown(0.45);
}
