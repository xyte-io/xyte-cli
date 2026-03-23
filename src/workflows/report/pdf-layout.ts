import type PDFKit from 'pdfkit';

import type { ReportFonts } from './font-asset';
import { getReportLogoBuffer, getReportLogoDimensions, REPORT_LOGO_FALLBACK_TEXT } from './logo-asset';
import { formatUtcForReport } from './time-format';
import { REPORT_THEME, getPanelTone, type ReportTone, type WindowFocus } from './theme';

const MM_TO_PT = 72 / 25.4;

export const PDF_LAYOUT = {
  pageMarginX: 25 * MM_TO_PT,
  pageMarginTop: 20 * MM_TO_PT,
  pageMarginBottom: 20 * MM_TO_PT,
  fullHeaderHeight: 104,
  fullHeaderContentGap: 14,
  minimalHeaderHeight: 30,
  minimalHeaderContentGap: 10,
  contentTopFirstPage: 20 * MM_TO_PT + 104 + 14,
  contentTopContinuation: 20 * MM_TO_PT + 30 + 10,
  footerHeight: 26,
  sectionHeadingFontSize: 17,
  sectionHeadingLineHeight: 26,
  sectionUnderlineGap: 6,
  sectionUnderlineThickness: 3,
  sectionUnderlineWidth: 44,
  sectionContentGap: 12,
  sectionGap: 32,
  bulletRowGap: 8,
  tableHeaderHeight: 36,
  tableRowMin: 28,
  tableRowMax: 220,
  tableCellPadTop: 10,
  tableCellPadBottom: 10,
  tableCellPadLeft: 16,
  tableCellPadRight: 12,
  heroRadius: 16,
  cardRadius: 12,
  cardGap: 10,
  insightCardMinHeight: 94
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
  doc
    .roundedRect(args.x, args.y, args.width, args.height, 7)
    .lineWidth(1)
    .fillAndStroke(REPORT_THEME.surface.badge, REPORT_THEME.accent.primary);
  doc.restore();
  useFont(doc, ctx, 'medium', fitted.fontSize, REPORT_THEME.accent.strong);
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
  const maxHeight = 24;
  const maxWidth = 92;
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
  const top = doc.page.margins.top;
  const width = right - left;

  if (mode === 'minimal') {
    doc.save();
    doc
      .roundedRect(left, top, width, PDF_LAYOUT.minimalHeaderHeight, 12)
      .lineWidth(1)
      .fillAndStroke(REPORT_THEME.surface.subtle, REPORT_THEME.border.default);
    doc.restore();

    useFont(doc, ctx, 'semibold', 9, REPORT_THEME.text.secondary);
    doc.text('Fleet Findings Report', left + 12, top + 10, {
      width: 190,
      lineBreak: false
    });

    const badgeWidth = 192;
    drawBadge(doc, ctx, {
      x: right - badgeWidth - 8,
      y: top + 5,
      width: badgeWidth,
      height: 20,
      fontSize: 8
    });
    return;
  }

  const heroX = left;
  const heroY = top;
  const heroWidth = width;
  const heroHeight = PDF_LAYOUT.fullHeaderHeight;
  const innerPadding = 18;
  const logoChipWidth = 116;
  const logoChipHeight = 34;
  const focusCardWidth = 184;
  const focusCardHeight = 38;
  const topRowY = heroY + 16;

  doc.save();
  doc
    .roundedRect(heroX, heroY, heroWidth, heroHeight, PDF_LAYOUT.heroRadius)
    .lineWidth(1)
    .fillAndStroke(REPORT_THEME.surface.hero, REPORT_THEME.border.default);
  doc.restore();

  doc.save();
  doc
    .roundedRect(heroX + innerPadding, topRowY, logoChipWidth, logoChipHeight, 12)
    .lineWidth(1)
    .fillAndStroke(REPORT_THEME.surface.page, REPORT_THEME.border.strong);
  doc.restore();

  drawHeaderLogo(doc, ctx, heroX + innerPadding + 12, topRowY + 5);
  const titleX = heroX + innerPadding;
  const titleWidth = heroWidth - innerPadding * 2;
  const tenantName = normalizedTenantName(ctx.tenantName);

  const focusCardX = heroX + heroWidth - innerPadding - focusCardWidth;
  const focusCardY = topRowY - 2;
  doc.save();
  doc
    .roundedRect(focusCardX, focusCardY, focusCardWidth, focusCardHeight, 12)
    .lineWidth(1)
    .fillAndStroke(REPORT_THEME.surface.heroSoft, REPORT_THEME.border.strong);
  doc.restore();

  useFont(doc, ctx, 'medium', 7.2, REPORT_THEME.text.inverseMuted);
  doc.text('WINDOW FOCUS', focusCardX + 12, focusCardY + 7, {
    width: focusCardWidth - 24,
    lineBreak: false,
    characterSpacing: 0.6
  });

  useFont(doc, ctx, 'semibold', 11.2, REPORT_THEME.text.inverse);
  doc.text(ctx.windowFocus.label, focusCardX + 12, focusCardY + 18, {
    width: focusCardWidth - 24,
    lineBreak: false,
    ellipsis: true
  });

  useFont(doc, ctx, 'regular', 8.2, REPORT_THEME.text.inverseMuted);
  doc.text(ctx.windowLabel, focusCardX + 12, focusCardY + 28, {
    width: focusCardWidth - 24,
    align: 'right',
    lineBreak: false
  });

  const titleFontSize = fitSingleLineFontSize(doc, ctx, 'bold', 'Fleet Findings Report', titleWidth, 20.5, 18);
  useFont(doc, ctx, 'bold', titleFontSize, REPORT_THEME.text.inverse);
  doc.text('Fleet Findings Report', titleX, heroY + 54, {
    width: titleWidth,
    lineBreak: false
  });

  const tenantLabel = tenantName ? tenantName : ctx.tenantId;
  useFont(doc, ctx, 'regular', 8.5, REPORT_THEME.text.inverseMuted);
  doc.text(
    `Operational snapshot for ${tenantLabel} - Generated ${formatUtcForReport(ctx.generatedAtUtc)}`,
    titleX,
    heroY + 80,
    {
      width: titleWidth,
      lineBreak: false,
      ellipsis: true
    }
  );

  doc.y = PDF_LAYOUT.contentTopFirstPage;
}

export function drawPdfFooter(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  pageNumber: number,
  pageCount: number
): void {
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

  useFont(doc, ctx, 'medium', 8.4, REPORT_THEME.text.tertiary);
  doc.text('SECTION', x, y, {
    width,
    lineBreak: false,
    ellipsis: false,
    characterSpacing: 1.1
  });

  const titleY = y + 10;
  useFont(doc, ctx, 'semibold', PDF_LAYOUT.sectionHeadingFontSize, REPORT_THEME.text.primary);
  doc.text(title, x, titleY, {
    width,
    lineBreak: false,
    ellipsis: true
  });

  if (options?.continued) {
    const titleSize = doc.widthOfString(title);
    const suffixX = x + Math.min(titleSize + 6, width - 90);
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(REPORT_THEME.text.tertiary);
    doc.text('(continued)', suffixX, titleY + 2, {
      width: 90,
      lineBreak: false
    });
  }

  const underlineY = titleY + PDF_LAYOUT.sectionHeadingLineHeight + PDF_LAYOUT.sectionUnderlineGap - 2;
  doc.save();
  doc
    .moveTo(x, underlineY)
    .lineTo(x + PDF_LAYOUT.sectionUnderlineWidth, underlineY)
    .lineWidth(PDF_LAYOUT.sectionUnderlineThickness)
    .strokeColor(REPORT_THEME.accent.primary)
    .stroke();
  doc
    .moveTo(x + PDF_LAYOUT.sectionUnderlineWidth + 8, underlineY)
    .lineTo(x + width, underlineY)
    .lineWidth(1)
    .strokeColor(REPORT_THEME.border.default)
    .stroke();
  doc.restore();

  doc.y = y + headingBlockHeight;
}

export function drawKpiGrid(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  cards: Array<{ label: string; value: string; detail?: string; tone?: 'normal' | 'warn' | 'bad' }>
): void {
  const visibleCards = cards.slice(0, 6);
  if (visibleCards.length === 0) {
    return;
  }
  const width = textWidth(doc);
  const gap = PDF_LAYOUT.cardGap;
  const rows = visibleCards.length > 4 ? [visibleCards.slice(0, 3), visibleCards.slice(3)] : [visibleCards];
  const rowGap = 10;
  const cardHeight = 88;
  const bottomGap = 18;
  const totalHeight = rows.length * cardHeight + (rows.length - 1) * rowGap;
  ensurePageSpace(doc, ctx, totalHeight + bottomGap);

  const topY = doc.y;
  rows.forEach((row, rowIndex) => {
    const rowY = topY + rowIndex * (cardHeight + rowGap);
    const cardWidth = (width - gap * (row.length - 1)) / row.length;

    row.forEach((card, index) => {
      const x = textLeft(doc) + index * (cardWidth + gap);
      const tone = getPanelTone(card.tone ?? 'normal');
      doc.save();
      doc
        .roundedRect(x, rowY, cardWidth, cardHeight, PDF_LAYOUT.cardRadius)
        .lineWidth(1)
        .fillAndStroke(tone.panel, tone.border);
      doc.roundedRect(x + 1, rowY + 1, cardWidth - 2, 4, 4).fill(tone.accent);
      doc.restore();

      const labelText = card.label.toUpperCase();
      const labelFontSize = fitSingleLineFontSize(doc, ctx, 'medium', labelText, cardWidth - 28, 7.8, 7);
      useFont(doc, ctx, 'medium', labelFontSize, tone.label);
      doc.text(labelText, x + 14, rowY + 14, {
        width: cardWidth - 28,
        lineBreak: false,
        ellipsis: false,
        characterSpacing: 0.55
      });

      const valueFontSize = fitSingleLineFontSize(doc, ctx, 'bold', card.value, cardWidth - 28, 26, 20);
      useFont(doc, ctx, 'bold', valueFontSize, tone.value);
      doc.text(card.value, x + 14, rowY + 32, {
        width: cardWidth - 28,
        lineBreak: false,
        ellipsis: false
      });

      if (card.detail) {
        useFont(doc, ctx, 'regular', 8.1, REPORT_THEME.text.secondary);
        doc.text(card.detail, x + 14, rowY + 58, {
          width: cardWidth - 28,
          lineGap: 0.2
        });
      }
    });
  });

  doc.y = topY + totalHeight + bottomGap;
}

export function drawInsightPanelGrid(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  panels: Array<{ eyebrow: string; title: string; body: string; tone?: ReportTone }>
): void {
  const visiblePanels = panels.slice(0, 3);
  if (!visiblePanels.length) {
    return;
  }

  const width = textWidth(doc);
  const gap = PDF_LAYOUT.cardGap;
  const panelWidth = (width - gap * (visiblePanels.length - 1)) / visiblePanels.length;
  const bottomGap = 24;

  const panelHeights = visiblePanels.map((panel) => {
    doc.font(ctx.fonts.medium).fontSize(7.8);
    const eyebrowHeight = doc.currentLineHeight();

    doc.font(ctx.fonts.semibold).fontSize(10.6);
    const titleHeight = doc.heightOfString(panel.title, {
      width: panelWidth - 28,
      lineGap: 0.8
    });

    doc.font(ctx.fonts.regular).fontSize(8.3);
    const bodyHeight = doc.heightOfString(panel.body, {
      width: panelWidth - 28,
      lineGap: 0.8
    });

    return Math.max(PDF_LAYOUT.insightCardMinHeight, 16 + eyebrowHeight + 8 + titleHeight + 8 + bodyHeight + 16);
  });

  const cardHeight = Math.max(...panelHeights);
  ensurePageSpace(doc, ctx, cardHeight + bottomGap);

  const startX = textLeft(doc);
  const topY = doc.y;

  visiblePanels.forEach((panel, index) => {
    const x = startX + index * (panelWidth + gap);
    const tone = getPanelTone(panel.tone ?? 'normal');

    doc.save();
    doc
      .roundedRect(x, topY, panelWidth, cardHeight, PDF_LAYOUT.cardRadius)
      .lineWidth(1)
      .fillAndStroke(tone.panel, tone.border);
    doc.roundedRect(x + 1, topY + 1, panelWidth - 2, 4, 4).fill(tone.accent);
    doc.restore();

    useFont(doc, ctx, 'medium', 7.8, tone.label);
    doc.text(panel.eyebrow.toUpperCase(), x + 14, topY + 14, {
      width: panelWidth - 28,
      lineBreak: false,
      ellipsis: true,
      characterSpacing: 0.55
    });

    useFont(doc, ctx, 'semibold', 10.6, tone.value);
    doc.text(panel.title, x + 14, topY + 30, {
      width: panelWidth - 28,
      lineGap: 0.8
    });

    useFont(doc, ctx, 'regular', 8.3, REPORT_THEME.text.secondary);
    doc.text(panel.body, x + 14, topY + 52, {
      width: panelWidth - 28,
      lineGap: 0.8
    });
  });

  doc.y = topY + cardHeight + bottomGap;
}

export function drawBullets(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, lines: string[]): void {
  const x = textLeft(doc);
  const width = textWidth(doc);
  const textX = x + 12;
  const textWidthValue = width - 12;

  for (const line of lines) {
    useFont(doc, ctx, 'regular', 10.2, REPORT_THEME.text.primary);
    const textHeight = doc.heightOfString(line, {
      width: textWidthValue,
      lineGap: 0
    });
    const needed = textHeight + PDF_LAYOUT.bulletRowGap;
    ensurePageSpace(doc, ctx, needed);

    const y = doc.y;
    doc.save();
    doc.circle(x + 2, y + 9, 2.3).fill(REPORT_THEME.accent.primary);
    doc.restore();

    useFont(doc, ctx, 'regular', 10.2, REPORT_THEME.text.primary);
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

export function drawSpaceBars(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  rows: Array<{ space: string; incidents: number }>
): void {
  if (!rows.length) {
    return;
  }

  drawSectionTitle(doc, ctx, `${ctx.windowLabel} churn concentration by space`);

  const x = textLeft(doc);
  const width = textWidth(doc);
  const labelWidth = Math.min(190, Math.floor(width * 0.4));
  const valueWidth = 36;
  const gapX = 12;
  const barHeight = 24;
  const rowGap = 12;
  const chartRows = rows.slice(0, 5);
  const panelPad = 16;
  const panelHeight = panelPad * 2 + chartRows.length * barHeight + (chartRows.length - 1) * rowGap;
  const barMaxWidth = width - panelPad * 2 - labelWidth - valueWidth - gapX - 6;
  const maxValue = Math.max(1, ...chartRows.map((row) => row.incidents));
  ensurePageSpace(doc, ctx, panelHeight + PDF_LAYOUT.sectionGap);

  const panelY = doc.y;
  doc.save();
  doc
    .roundedRect(x, panelY, width, panelHeight, 14)
    .lineWidth(1)
    .fillAndStroke(REPORT_THEME.surface.subtle, REPORT_THEME.border.default);
  doc.restore();

  chartRows.forEach((row, index) => {
    const y = panelY + panelPad + index * (barHeight + rowGap);
    const barWidth = Math.max(2, Math.round((row.incidents / maxValue) * barMaxWidth));
    const trackX = x + panelPad + labelWidth + gapX;

    useFont(doc, ctx, 'regular', 9.5, REPORT_THEME.text.primary);
    doc.text(row.space, x + panelPad, y + 7, {
      width: labelWidth - 4,
      lineBreak: false,
      ellipsis: true
    });

    doc.save();
    doc.roundedRect(trackX, y, barMaxWidth, barHeight, barHeight / 2).fill(REPORT_THEME.surface.subtleAlt);
    doc.restore();
    drawBarRightRounded(doc, trackX, y, barWidth, barHeight, REPORT_THEME.accent.primary);

    useFont(doc, ctx, 'bold', 9.5, REPORT_THEME.text.secondary);
    doc.text(String(row.incidents), trackX + barMaxWidth + 6, y + 7, {
      width: valueWidth,
      align: 'right',
      lineBreak: false
    });
  });

  doc.y = panelY + panelHeight + PDF_LAYOUT.sectionGap;
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
  doc
    .moveTo(x, y)
    .lineTo(x + width, y)
    .lineWidth(1)
    .strokeColor(REPORT_THEME.border.default)
    .stroke();
  doc.restore();
  doc.y = y + 8;
}
