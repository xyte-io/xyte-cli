import type PDFKit from 'pdfkit';

import type { ReportFonts } from './font-asset';
import { getReportLogoBuffer, getReportLogoDimensions, REPORT_LOGO_FALLBACK_TEXT } from './logo-asset';
import { formatUtcForReport } from './time-format';
import { REPORT_THEME, getMetricTone, type WindowFocus } from './theme';

const MM_TO_PT = 72 / 25.4;

export const PDF_LAYOUT = {
  pageMarginX: 25 * MM_TO_PT,
  pageMarginTop: 20 * MM_TO_PT,
  pageMarginBottom: 20 * MM_TO_PT,
  fullHeaderHeight: 86,
  fullHeaderContentGap: 24,
  minimalHeaderHeight: 24,
  minimalHeaderContentGap: 12,
  contentTopFirstPage: 20 * MM_TO_PT + 86 + 24,
  contentTopContinuation: 20 * MM_TO_PT + 24 + 12,
  footerHeight: 26,
  sectionHeadingFontSize: 16,
  sectionHeadingLineHeight: 24,
  sectionUnderlineGap: 4,
  sectionUnderlineThickness: 2,
  sectionUnderlineWidth: 32,
  sectionContentGap: 12,
  sectionGap: 28,
  bulletRowGap: 6,
  tableHeaderHeight: 34,
  tableRowMin: 28,
  tableRowMax: 220,
  tableCellPadTop: 10,
  tableCellPadBottom: 10,
  tableCellPadLeft: 16,
  tableCellPadRight: 12
} as const;

export interface PdfRenderContext {
  tenantId: string;
  tenantName?: string;
  generatedAtUtc: string;
  windowHours: number;
  windowLabel: string;
  windowFocus: WindowFocus;
  fonts: ReportFonts;
}

type HeaderMode = 'full' | 'minimal';
type FontWeight = keyof ReportFonts;

function textWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function textLeft(doc: PDFKit.PDFDocument): number {
  return doc.page.margins.left;
}

function textRight(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.right;
}

function contentBottom(doc: PDFKit.PDFDocument): number {
  return doc.page.height - doc.page.margins.bottom - PDF_LAYOUT.footerHeight;
}

function useFont(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  weight: FontWeight,
  size: number,
  color: string,
  lineGap?: number
): void {
  doc.font(ctx.fonts[weight]).fontSize(size).fillColor(color);
  if (lineGap !== undefined) {
    doc.lineGap(lineGap);
  }
}

function normalizedTenantName(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function fitSingleLineFontSize(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  weight: FontWeight,
  text: string,
  maxWidth: number,
  preferred: number,
  min: number
): number {
  for (let size = preferred; size >= min; size -= 0.5) {
    doc.font(ctx.fonts[weight]).fontSize(size);
    if (doc.widthOfString(text) <= maxWidth) {
      return size;
    }
  }
  return min;
}

function fitBadgeLabel(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  maxWidth: number,
  preferredSize: number
): { label: string; fontSize: number } {
  const fullLabel = `${ctx.windowLabel} - ${ctx.windowFocus.label}`;
  const shortLabel = ctx.windowLabel;
  const fullSize = fitSingleLineFontSize(doc, ctx, 'medium', fullLabel, maxWidth, preferredSize, 7);
  if (doc.widthOfString(fullLabel) <= maxWidth) {
    return {
      label: fullLabel,
      fontSize: fullSize
    };
  }

  return {
    label: shortLabel,
    fontSize: fitSingleLineFontSize(doc, ctx, 'medium', shortLabel, maxWidth, preferredSize, 7)
  };
}

function drawBadge(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  args: {
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
  }
): void {
  const textPaddingX = 8;
  const maxLabelWidth = Math.max(20, args.width - textPaddingX * 2);
  const fitted = fitBadgeLabel(doc, ctx, maxLabelWidth, args.fontSize);
  doc.save();
  doc.roundedRect(args.x, args.y, args.width, args.height, 6).lineWidth(1).fillAndStroke(REPORT_THEME.surface.badge, REPORT_THEME.accent.primary);
  doc.restore();
  useFont(doc, ctx, 'medium', fitted.fontSize, REPORT_THEME.accent.primary);
  const textHeight = doc.currentLineHeight();
  const textY = args.y + Math.max(0, (args.height - textHeight) / 2);
  doc.text(fitted.label, args.x + textPaddingX, textY, {
    width: maxLabelWidth,
    align: 'center',
    lineBreak: false,
    ellipsis: false
  });
}

function drawHeaderLogo(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, x: number, y: number): number {
  const logoBuffer = getReportLogoBuffer();
  const maxHeight = 36;
  const maxWidth = 128;
  const dimensions = getReportLogoDimensions();
  const ratio = dimensions.height > 0 ? dimensions.width / dimensions.height : 1;
  const renderedWidth = Math.min(maxWidth, maxHeight * ratio);
  const renderedHeight = renderedWidth / ratio;
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, x, y, {
        fit: [renderedWidth, renderedHeight]
      });
      return renderedWidth;
    } catch {
      // Fall through to text fallback.
    }
  }

  useFont(doc, ctx, 'bold', 22, REPORT_THEME.text.primary);
  doc.text(REPORT_LOGO_FALLBACK_TEXT, x, y + 6, {
    width: renderedWidth,
    lineBreak: false
  });
  return renderedWidth;
}

export function drawPdfHeader(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, mode: HeaderMode = 'full'): void {
  const left = textLeft(doc);
  const right = textRight(doc);
  const width = textWidth(doc);
  const top = doc.page.margins.top;

  if (mode === 'minimal') {
    doc.save();
    doc.moveTo(left, top).lineTo(right, top).lineWidth(1).strokeColor(REPORT_THEME.border.default).stroke();
    doc.restore();

    useFont(doc, ctx, 'regular', 9, REPORT_THEME.text.tertiary);
    doc.text('Fleet Findings Report', left, top + 8, {
      width: 180,
      lineBreak: false
    });

    const badgeWidth = 204;
    drawBadge(doc, ctx, {
      x: right - badgeWidth,
      y: top + 4,
      width: badgeWidth,
      height: 18,
      fontSize: 8
    });
    return;
  }

  const logoWidth = drawHeaderLogo(doc, ctx, left, top + 6);
  const badgeWidth = 200;
  const badgeX = right - badgeWidth;
  const titleX = left + logoWidth + 16;
  const titleWidth = right - titleX;
  const metadataWidth = badgeX - titleX - 12;
  const tenantName = normalizedTenantName(ctx.tenantName);

  useFont(doc, ctx, 'bold', 24, REPORT_THEME.text.primary);
  doc.text('Fleet Findings Report', titleX, top + 2, {
    width: titleWidth,
    lineBreak: false
  });

  useFont(doc, ctx, 'regular', 9, REPORT_THEME.text.secondary);
  let generatedY = top + 44;
  if (tenantName) {
    doc.text(`Tenant: ${tenantName}`, titleX, top + 38, {
      width: metadataWidth,
      lineBreak: false,
      ellipsis: false
    });
    generatedY = top + 52;
  }

  doc.text(`Generated: ${formatUtcForReport(ctx.generatedAtUtc)}`, titleX, generatedY, {
    width: metadataWidth,
    lineBreak: false
  });

  drawBadge(doc, ctx, {
    x: badgeX,
    y: top + 36,
    width: badgeWidth,
    height: 28,
    fontSize: 9
  });

  doc.y = PDF_LAYOUT.contentTopFirstPage;
}

export function drawPdfFooter(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, pageNumber: number, pageCount: number): void {
  const left = textLeft(doc);
  const right = textRight(doc);
  const safeBottom = Math.min(doc.page.height - doc.page.margins.bottom, doc.page.height - 72);
  const lineY = safeBottom - 19;
  const textY = lineY + 8;

  doc.save();
  doc.moveTo(left, lineY).lineTo(right, lineY).lineWidth(1).strokeColor(REPORT_THEME.border.default).stroke();
  doc.restore();

  useFont(doc, ctx, 'regular', 8, REPORT_THEME.text.tertiary);
  doc.text('Xyte Fleet Findings Report', left, textY, {
    width: 180,
    align: 'left',
    lineBreak: false
  });
  doc.text(ctx.windowLabel, left + 180, textY, {
    width: 130,
    align: 'center',
    lineBreak: false
  });
  doc.text(`Page ${pageNumber} of ${pageCount}`, right - 130, textY, {
    width: 130,
    align: 'right',
    lineBreak: false
  });
}

export function startReportPage(doc: PDFKit.PDFDocument, ctx: PdfRenderContext): void {
  doc.addPage();
  drawPdfHeader(doc, ctx, 'minimal');
  doc.x = textLeft(doc);
  doc.y = PDF_LAYOUT.contentTopContinuation;
}

export function ensurePageSpace(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, minHeight: number): void {
  if (doc.y + minHeight <= contentBottom(doc)) {
    return;
  }
  startReportPage(doc, ctx);
}

export function drawSectionTitle(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  title: string,
  options?: { continued?: boolean }
): void {
  const headingBlockHeight =
    PDF_LAYOUT.sectionHeadingLineHeight +
    PDF_LAYOUT.sectionUnderlineGap +
    PDF_LAYOUT.sectionUnderlineThickness +
    PDF_LAYOUT.sectionContentGap;
  ensurePageSpace(doc, ctx, headingBlockHeight);

  const x = textLeft(doc);
  const y = doc.y;
  const width = textWidth(doc);

  useFont(doc, ctx, 'semibold', PDF_LAYOUT.sectionHeadingFontSize, REPORT_THEME.text.primary);
  doc.text(title, x, y, {
    width,
    lineBreak: false,
    ellipsis: true
  });

  if (options?.continued) {
    const titleSize = doc.widthOfString(title);
    const suffixX = x + Math.min(titleSize + 6, width - 90);
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(REPORT_THEME.text.tertiary);
    doc.text('(continued)', suffixX, y + 2, {
      width: 90,
      lineBreak: false
    });
  }

  const underlineY = y + PDF_LAYOUT.sectionHeadingLineHeight + PDF_LAYOUT.sectionUnderlineGap;
  doc.save();
  doc.moveTo(x, underlineY).lineTo(x + PDF_LAYOUT.sectionUnderlineWidth, underlineY).lineWidth(PDF_LAYOUT.sectionUnderlineThickness).strokeColor(REPORT_THEME.accent.primary).stroke();
  doc.restore();

  doc.y = y + headingBlockHeight;
}

export function drawKpiGrid(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  cards: Array<{ label: string; value: string; tone?: 'normal' | 'warn' | 'bad' }>
): void {
  const visibleCards = cards.slice(0, 4);
  if (visibleCards.length === 0) {
    return;
  }
  const width = textWidth(doc);
  const gap = 12;
  const cardCount = visibleCards.length;
  const cardWidth = (width - gap * (cardCount - 1)) / cardCount;
  const cardHeight = 84;
  ensurePageSpace(doc, ctx, cardHeight + PDF_LAYOUT.sectionGap);

  const startX = textLeft(doc);
  const topY = doc.y;

  visibleCards.forEach((card, index) => {
    const x = startX + index * (cardWidth + gap);
    const tone = getMetricTone(card.tone ?? 'normal');
    doc.save();
    doc.roundedRect(x, topY, cardWidth, cardHeight, 8).lineWidth(1).fillAndStroke(tone.panel, tone.border);
    doc.restore();

    const labelText = card.label.toUpperCase();
    const labelFontSize = fitSingleLineFontSize(doc, ctx, 'regular', labelText, cardWidth - 40, 8.5, 7.5);
    useFont(doc, ctx, 'regular', labelFontSize, REPORT_THEME.text.secondary);
    doc.text(card.label.toUpperCase(), x + 20, topY + 16, {
      width: cardWidth - 40,
      lineBreak: false,
      ellipsis: false
    });

    const valueFontSize = fitSingleLineFontSize(doc, ctx, 'bold', card.value, cardWidth - 40, 28, 24);
    useFont(doc, ctx, 'bold', valueFontSize, REPORT_THEME.text.primary);
    doc.text(card.value, x + 20, topY + 40, {
      width: cardWidth - 40,
      lineBreak: false,
      ellipsis: false
    });
  });

  doc.y = topY + cardHeight + PDF_LAYOUT.sectionGap;
}

export function drawBullets(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, lines: string[]): void {
  const x = textLeft(doc);
  const width = textWidth(doc);
  const textX = x + 12;
  const textWidthValue = width - 12;

  for (const line of lines) {
    useFont(doc, ctx, 'regular', 10, REPORT_THEME.text.primary);
    const textHeight = doc.heightOfString(line, {
      width: textWidthValue,
      lineGap: 0
    });
    const needed = textHeight + PDF_LAYOUT.bulletRowGap;
    ensurePageSpace(doc, ctx, needed);

    const y = doc.y;
    doc.save();
    doc.circle(x + 2, y + 9, 2).fill(REPORT_THEME.text.tertiary);
    doc.restore();

    useFont(doc, ctx, 'regular', 10, REPORT_THEME.text.primary);
    doc.text(line, textX, y, {
      width: textWidthValue,
      lineGap: 0
    });
    doc.y = y + textHeight + PDF_LAYOUT.bulletRowGap;
  }
}

function drawBarRightRounded(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string
): void {
  if (width <= 0) {
    return;
  }

  const radius = height / 2;
  if (width <= radius) {
    doc.save();
    doc.circle(x + width / 2, y + radius, width / 2).fill(color);
    doc.restore();
    return;
  }

  doc.save();
  doc.rect(x, y, width - radius, height).fill(color);
  doc.circle(x + width - radius, y + radius, radius).fill(color);
  doc.restore();
}

export function drawSpaceBars(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, rows: Array<{ space: string; incidents: number }>): void {
  if (!rows.length) {
    return;
  }

  drawSectionTitle(doc, ctx, `${ctx.windowLabel} churn concentration by space`);

  const x = textLeft(doc);
  const width = textWidth(doc);
  const labelWidth = Math.min(210, Math.floor(width * 0.44));
  const valueWidth = 36;
  const gapX = 12;
  const barHeight = 24;
  const rowGap = 12;
  const barMaxWidth = width - labelWidth - valueWidth - gapX - 6;
  const chartRows = rows.slice(0, 5);
  const maxValue = Math.max(1, ...chartRows.map((row) => row.incidents));

  chartRows.forEach((row, index) => {
    ensurePageSpace(doc, ctx, barHeight + (index < chartRows.length - 1 ? rowGap : 0));
    const y = doc.y;
    const barWidth = Math.max(2, Math.round((row.incidents / maxValue) * barMaxWidth));

    useFont(doc, ctx, 'regular', 9.5, REPORT_THEME.text.primary);
    doc.text(row.space, x, y + 7, {
      width: labelWidth - 4,
      lineBreak: false,
      ellipsis: true
    });

    drawBarRightRounded(doc, x + labelWidth + gapX, y, barWidth, barHeight, REPORT_THEME.accent.primary);

    useFont(doc, ctx, 'bold', 9.5, REPORT_THEME.text.secondary);
    doc.text(String(row.incidents), x + labelWidth + gapX + barMaxWidth + 6, y + 7, {
      width: valueWidth,
      align: 'right',
      lineBreak: false
    });

    doc.y = y + barHeight + (index < chartRows.length - 1 ? rowGap : 0);
  });

  doc.y += PDF_LAYOUT.sectionGap;
}

export function drawEndOfReportDivider(doc: PDFKit.PDFDocument): void {
  const width = textWidth(doc) * 0.4;
  const x = textLeft(doc) + (textWidth(doc) - width) / 2;
  const maxY = contentBottom(doc) - 2;
  const y = Math.min(maxY, doc.y + 24);
  if (y <= doc.y) {
    return;
  }

  doc.save();
  doc.moveTo(x, y).lineTo(x + width, y).lineWidth(1).strokeColor(REPORT_THEME.border.default).stroke();
  doc.restore();
  doc.y = y + 8;
}
