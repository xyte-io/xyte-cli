import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type PDFKit from 'pdfkit';

import { XYTE_PALETTE, getMetricTone, type WindowFocus } from './theme';

export const PDF_LAYOUT = {
  pageMarginX: 46,
  pageMarginY: 42,
  headerTop: 16,
  headerHeight: 82,
  footerHeight: 24,
  contentTop: 118,
  spaceSm: 8,
  spaceMd: 12,
  spaceLg: 20,
  fontH1: 18,
  fontH2: 13,
  fontBody: 10,
  fontCaption: 9,
  tableRowMin: 22,
  tableRowMax: 220,
  tableCellPadX: 6,
  tableCellPadY: 5
} as const;

export interface PdfRenderContext {
  tenantId: string;
  generatedAtUtc: string;
  windowHours: number;
  windowFocus: WindowFocus;
  logoPath?: string;
}

function identifier(value: unknown): string {
  if (value === undefined || value === null) {
    return 'n/a';
  }
  return String(value);
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  const normalized = trimmed.replace(/\s+/, 'T');
  const parts = normalized.match(
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i
  );

  if (parts) {
    const date = parts[1];
    const hour = parts[2] ?? '00';
    const minute = parts[3] ?? '00';
    const second = parts[4] ?? '00';
    const fraction = parts[5] ? `.${parts[5].slice(0, 3).padEnd(3, '0')}` : '';
    const zoneRaw = parts[6] ?? 'Z';
    const zone = /^[+-]\d{4}$/.test(zoneRaw)
      ? `${zoneRaw.slice(0, 3)}:${zoneRaw.slice(3)}`
      : /^[+-]\d{2}$/.test(zoneRaw)
        ? `${zoneRaw}:00`
        : zoneRaw;
    const iso = `${date}T${hour}:${minute}:${second}${fraction}${zone}`;
    const parsedIso = new Date(iso);
    if (!Number.isNaN(parsedIso.getTime())) {
      return parsedIso;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && !/(Z|[+-]\d{2}(?::?\d{2})?)$/i.test(trimmed)) {
    const asUtc = new Date(`${trimmed}Z`);
    if (!Number.isNaN(asUtc.getTime())) {
      return asUtc;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const asDateUtc = new Date(`${trimmed}T00:00:00Z`);
    if (!Number.isNaN(asDateUtc.getTime())) {
      return asDateUtc;
    }
  }

  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  return undefined;
}

function formatTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatUtcForReport(value: unknown): string {
  const parsed = parseTimestamp(value);
  if (!parsed) {
    return identifier(value);
  }
  const y = parsed.getUTCFullYear();
  const m = formatTwoDigits(parsed.getUTCMonth() + 1);
  const d = formatTwoDigits(parsed.getUTCDate());
  const hh = formatTwoDigits(parsed.getUTCHours());
  const mm = formatTwoDigits(parsed.getUTCMinutes());
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

export function resolveLogoPath(): string | undefined {
  const candidates = [
    resolve(process.cwd(), 'assets/xyte-logo.png'),
    resolve(__dirname, '../../assets/xyte-logo.png'),
    resolve(__dirname, '../../../assets/xyte-logo.png')
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function resetCursor(doc: PDFKit.PDFDocument): void {
  doc.x = doc.page.margins.left;
  doc.y = Math.max(doc.y, PDF_LAYOUT.contentTop);
}

export function drawPdfHeader(doc: PDFKit.PDFDocument, ctx: PdfRenderContext): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const shellTop = PDF_LAYOUT.headerTop;
  const shellHeight = PDF_LAYOUT.headerHeight;

  doc.save();
  doc.roundedRect(left, shellTop, right - left, shellHeight, 10).fillAndStroke(XYTE_PALETTE.paperBlue, XYTE_PALETTE.borderStrong);
  doc.restore();

  doc.save();
  doc.roundedRect(left + 12, shellTop + 12, 126, shellHeight - 24, 9).fillAndStroke(XYTE_PALETTE.navy900, XYTE_PALETTE.navy700);
  doc.restore();

  doc.save();
  doc.roundedRect(left + 10, shellTop + 6, right - left - 20, 7, 3).fill(XYTE_PALETTE.aqua);
  doc.restore();

  if (ctx.logoPath) {
    try {
      doc.image(ctx.logoPath, left + 18, shellTop + 31, { fit: [108, 28] });
    } catch {
      doc.font('Helvetica-Bold').fontSize(28).fillColor(XYTE_PALETTE.aquaBright).text('XYTE', left + 22, shellTop + 31);
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(28).fillColor(XYTE_PALETTE.aquaBright).text('XYTE', left + 22, shellTop + 31);
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(PDF_LAYOUT.fontH1)
    .fillColor(XYTE_PALETTE.ink950)
    .text('Fleet Findings Report', left + 154, shellTop + 20, { width: right - left - 260, align: 'left' });
  doc
    .font('Helvetica')
    .fontSize(PDF_LAYOUT.fontBody)
    .fillColor(XYTE_PALETTE.slate700)
    .text(`Tenant: ${ctx.tenantId}`, left + 154, shellTop + 45, { width: right - left - 260, align: 'left' })
    .text(`Generated: ${formatUtcForReport(ctx.generatedAtUtc)}`, left + 154, shellTop + 59, { width: right - left - 260, align: 'left' });

  const badgeWidth = 188;
  const badgeHeight = 34;
  const badgeX = right - badgeWidth - 12;
  const badgeY = shellTop + 25;
  doc.save();
  doc.roundedRect(badgeX - 2, badgeY - 2, badgeWidth + 4, badgeHeight + 4, 16).fillAndStroke(XYTE_PALETTE.paper, XYTE_PALETTE.borderInk);
  doc.restore();
  doc.save();
  doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 15).fill(ctx.windowFocus.accent);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(PDF_LAYOUT.fontCaption).fillColor(XYTE_PALETTE.paper).text(
    `${ctx.windowHours}h - ${ctx.windowFocus.label}`,
    badgeX + 10,
    badgeY + 12,
    { width: badgeWidth - 24, align: 'center' }
  );
}

export function drawPdfFooter(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, pageNumber: number, pageCount: number): void {
  const y = doc.page.height - doc.page.margins.bottom - PDF_LAYOUT.footerHeight + 10;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.save();
  doc.moveTo(left, y - 6).lineTo(right, y - 6).lineWidth(0.6).strokeColor(XYTE_PALETTE.borderStrong).stroke();
  doc.restore();
  doc.font('Helvetica').fontSize(PDF_LAYOUT.fontCaption).fillColor(XYTE_PALETTE.slate500).text('Xyte Fleet Findings Report', left, y, { width: 220, align: 'left' });
  doc.text(`${ctx.windowHours}h window`, left + 220, y, { width: 120, align: 'center' });
  doc.text(`Page ${pageNumber} of ${pageCount}`, right - 120, y, { width: 120, align: 'right' });
}

export function startReportPage(doc: PDFKit.PDFDocument, ctx: PdfRenderContext): void {
  doc.addPage();
  drawPdfHeader(doc, ctx);
  resetCursor(doc);
}

export function ensurePageSpace(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, minHeight: number): void {
  resetCursor(doc);
  const bottom = doc.page.height - doc.page.margins.bottom - PDF_LAYOUT.footerHeight - PDF_LAYOUT.spaceSm;
  if (doc.y + minHeight <= bottom) {
    return;
  }
  startReportPage(doc, ctx);
}

export function drawSectionTitle(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, title: string): void {
  ensurePageSpace(doc, ctx, 34);
  resetCursor(doc);
  doc.moveDown(0.25);
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.save();
  doc.roundedRect(x, y - 2, 6, 16, 2).fill(ctx.windowFocus.accent);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(PDF_LAYOUT.fontH2).fillColor(XYTE_PALETTE.ink900).text(title, x + 12, y - 1, {
    width: width - 12
  });
  const lineY = doc.y + 2;
  doc.save();
  doc.moveTo(x, lineY).lineTo(doc.page.width - doc.page.margins.right, lineY).lineWidth(0.9).strokeColor(XYTE_PALETTE.borderStrong).stroke();
  doc.restore();
  doc.moveDown(0.25);
}

export function drawWindowFocusStrip(doc: PDFKit.PDFDocument, ctx: PdfRenderContext): void {
  ensurePageSpace(doc, ctx, 62);
  resetCursor(doc);
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const height = 54;
  doc.save();
  doc.roundedRect(x, y, width, height, 8).fillAndStroke(ctx.windowFocus.panel, XYTE_PALETTE.borderStrong);
  doc.restore();
  doc.save();
  doc.roundedRect(x + 10, y + 9, 5, height - 18, 2).fill(ctx.windowFocus.accent);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(PDF_LAYOUT.fontBody).fillColor(ctx.windowFocus.accent).text('Window Focus', x + 24, y + 10);
  doc.font('Helvetica').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.ink700).text(ctx.windowFocus.detail, x + 120, y + 10, {
    width: width - 132
  });
  doc.y = y + height + PDF_LAYOUT.spaceLg;
}

export function drawKpiGrid(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  cards: Array<{ label: string; value: string; tone?: 'normal' | 'warn' | 'bad' }>
): void {
  ensurePageSpace(doc, ctx, 118);
  resetCursor(doc);
  const startX = doc.page.margins.left;
  const topY = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = PDF_LAYOUT.spaceSm;
  const cardWidth = Math.floor((width - gap * 3) / 4);
  const cardHeight = 92;

  cards.slice(0, 4).forEach((card, index) => {
    const x = startX + index * (cardWidth + gap);
    const tone = getMetricTone(card.tone ?? 'normal');

    doc.save();
    doc.roundedRect(x, topY, cardWidth, cardHeight, 9).fillAndStroke(tone.panel, tone.border);
    doc.roundedRect(x + 1, topY + 1, cardWidth - 2, 6, 3).fill(tone.accent);
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(tone.label).text(card.label, x + 10, topY + 16, {
      width: cardWidth - 20
    });
    doc.font('Helvetica-Bold').fontSize(27).fillColor(tone.value).text(card.value, x + 10, topY + 42, {
      width: cardWidth - 20
    });
  });

  doc.y = topY + cardHeight + PDF_LAYOUT.spaceLg;
}

export function drawKeyFindings(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, lines: string[]): void {
  const findings = lines.slice(0, 4);
  if (!findings.length) {
    return;
  }

  ensurePageSpace(doc, ctx, 88);
  resetCursor(doc);
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const panelHeight = 66 + findings.length * 12;
  doc.save();
  doc.roundedRect(x, y, width, panelHeight, 8).fillAndStroke(XYTE_PALETTE.mist, XYTE_PALETTE.borderStrong);
  doc.roundedRect(x + 10, y + 9, 5, panelHeight - 18, 2).fill(XYTE_PALETTE.aqua);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.ink900).text('Key Findings', x + 24, y + 10);
  let cursorY = y + 30;
  findings.forEach((line) => {
    doc.save();
    doc.circle(x + 28, cursorY + 6, 2.3).fill(ctx.windowFocus.accent);
    doc.restore();
    doc.font('Helvetica').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.ink700).text(line, x + 36, cursorY, {
      width: width - 48
    });
    cursorY += 16;
  });
  doc.y = y + panelHeight + PDF_LAYOUT.spaceLg;
}

export function drawBullets(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, lines: string[]): void {
  lines.forEach((line) => {
    ensurePageSpace(doc, ctx, 20);
    resetCursor(doc);
    const x = doc.page.margins.left;
    const y = doc.y + 6;
    doc.save();
    doc.circle(x + 5, y, 2).fill(XYTE_PALETTE.aqua);
    doc.restore();
    doc.font('Helvetica').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.ink700).text(line, x + 14, doc.y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 14
    });
    doc.moveDown(0.1);
  });
}

export function drawSpaceBars(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, rows: Array<{ space: string; incidents: number }>): void {
  if (!rows.length) {
    return;
  }
  drawSectionTitle(doc, ctx, `${ctx.windowHours}h Churn Concentration (Top Spaces)`);
  const chartRows = rows.slice(0, 5);
  const maxValue = Math.max(...chartRows.map((row) => row.incidents), 1);
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const labelWidth = 285;
  const valueWidth = 50;
  const barWidth = pageWidth - labelWidth - valueWidth - 20;
  chartRows.forEach((row) => {
    ensurePageSpace(doc, ctx, 26);
    resetCursor(doc);
    const y = doc.y;
    const x = doc.page.margins.left;
    const ratio = row.incidents / maxValue;
    doc.font('Helvetica').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.ink700).text(row.space, x, y + 5, {
      width: labelWidth - 8,
      ellipsis: true
    });
    doc.save();
    const valueWidthPx = Math.max(8, barWidth * ratio);
    doc.roundedRect(x + labelWidth, y + 8, barWidth, 10, 4).fill('#E5EDF4');
    doc.roundedRect(x + labelWidth, y + 8, valueWidthPx, 10, 4).fill(XYTE_PALETTE.blue);
    doc.circle(x + labelWidth + valueWidthPx, y + 13, 2.5).fill(ctx.windowFocus.accent);
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(PDF_LAYOUT.fontBody).fillColor(XYTE_PALETTE.ink700).text(String(row.incidents), x + labelWidth + barWidth + 8, y + 5, {
      width: valueWidth,
      align: 'right'
    });
    doc.y = y + 24;
  });
  doc.moveDown(0.45);
}
