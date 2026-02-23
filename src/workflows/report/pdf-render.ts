import { createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import PDFDocument from 'pdfkit';

import type { DeepDiveResult } from '../fleet-insights';
import { drawTable } from './pdf-table';
import {
  PDF_LAYOUT,
  drawBullets,
  drawEndOfReportDivider,
  drawKpiGrid,
  drawPdfFooter,
  drawPdfHeader,
  drawSectionTitle,
  drawSpaceBars,
  type PdfRenderContext
} from './pdf-layout';
import { registerReportFonts } from './font-asset';
import { formatRelativeAgeFromHours, formatUtcForReport, formatWindowLabel } from './time-format';
import { REPORT_THEME, getWindowFocus } from './theme';

function ensureDir(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

function redactSensitive(value: string, includeSensitive: boolean): string {
  if (includeSensitive || value === 'n/a') {
    return value;
  }
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function compactIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'n/a' || trimmed === '***') {
    return trimmed || 'n/a';
  }

  if (trimmed.includes('...') && trimmed.length > 10) {
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-3)}`;
  }

  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed);
  const looksLikeLongHex = /^[0-9a-f]{20,}$/i.test(trimmed);
  if (looksLikeUuid || looksLikeLongHex || trimmed.length > 28) {
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-3)}`;
  }

  return trimmed;
}

function formatSpaceHierarchy(spacePath: string): string {
  const value = spacePath.trim();
  if (!value) {
    return 'n/a';
  }

  const parts = value.split('/').filter(Boolean);
  if (parts.length <= 2) {
    return value;
  }

  const leaf = parts.at(-1) ?? value;
  const context = parts.slice(Math.max(0, parts.length - 3), parts.length - 1);
  if (!context.length) {
    return leaf;
  }
  return `${leaf} (${context.join(' / ')})`;
}

export function renderBrandedPdfReport(deepDive: DeepDiveResult, outputPath: string, includeSensitive: boolean): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    ensureDir(outputPath);
    const windowLabel = formatWindowLabel(deepDive.windowHours);
    const summaryLines = Array.from(
      new Set(
        deepDive.summary
          .map((line) => line.replace(/^(\d+)h churn:/i, `${windowLabel} churn:`).trim())
          .filter(Boolean)
      )
    );

    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        left: PDF_LAYOUT.pageMarginX,
        right: PDF_LAYOUT.pageMarginX,
        top: PDF_LAYOUT.pageMarginTop,
        bottom: PDF_LAYOUT.pageMarginBottom
      },
      bufferPages: true,
      compress: false
    });
    const fonts = registerReportFonts(doc);

    const ctx: PdfRenderContext = {
      tenantId: deepDive.tenantId,
      tenantName: typeof deepDive.tenantName === 'string' ? deepDive.tenantName : undefined,
      generatedAtUtc: deepDive.generatedAtUtc,
      windowHours: deepDive.windowHours,
      windowLabel,
      windowFocus: getWindowFocus(deepDive.windowHours),
      fonts
    };
    const stream = doc.pipe(createWriteStream(outputPath));

    stream.on('finish', () => resolvePromise());
    stream.on('error', (error) => rejectPromise(error));

    drawPdfHeader(doc, ctx, 'full');
    doc.x = doc.page.margins.left;
    doc.y = PDF_LAYOUT.contentTopFirstPage;

    drawKpiGrid(doc, ctx, [
      { label: 'Active incidents', value: String(deepDive.activeIncidentAging.length) },
      { label: windowLabel, value: String(deepDive.churn24h.incidents) },
      { label: 'Open tickets', value: String(deepDive.ticketPosture.openTickets) },
      {
        label: 'Data mismatches',
        value: String(deepDive.dataQuality.statusMismatches.length)
      }
    ]);

    drawSectionTitle(doc, ctx, 'Executive Summary');
    drawBullets(doc, ctx, summaryLines);
    doc.y += PDF_LAYOUT.sectionGap;

    drawSpaceBars(
      doc,
      ctx,
      deepDive.churn24h.bySpace.map((row) => ({
        space: formatSpaceHierarchy(row.space),
        incidents: row.incidents
      }))
    );

    drawTable(doc, ctx, {
      title: 'Top Spaces by Offline Devices',
      columns: [
        { header: 'Space', width: 293, wrap: true },
        { header: 'Offline', width: 80, align: 'right', wrap: false },
        { header: 'Share', width: 80, align: 'right', wrap: false }
      ],
      rows: deepDive.topOfflineSpaces.map((row) => [
        formatSpaceHierarchy(row.space),
        String(row.offlineDevices),
        `${row.shareOfOfflinePct}%`
      ]),
      emptyMessage: 'No offline spaces found.'
    });

    drawTable(doc, ctx, {
      title: 'Top Devices by Incident Volume',
      columns: [
        { header: 'Device', width: 293, wrap: true },
        { header: 'Incidents', width: 80, align: 'right', wrap: false },
        { header: 'Active', width: 80, align: 'right', wrap: false }
      ],
      rows: deepDive.topIncidentDevices.map((row) => [
        compactIdentifier(row.device),
        String(row.incidentCount),
        String(row.activeIncidents)
      ]),
      emptyMessage: 'No incident device concentration detected.'
    });

    drawTable(doc, ctx, {
      title: 'Active Incident Aging',
      columns: [
        { header: 'Device', width: 94, wrap: true },
        { header: 'Space', width: 159, wrap: true },
        { header: 'Age', width: 82, align: 'right', wrap: false },
        { header: 'Created At (UTC)', width: 118, wrap: true }
      ],
      rows: deepDive.activeIncidentAging.map((row) => [
        compactIdentifier(row.device),
        formatSpaceHierarchy(row.space),
        formatRelativeAgeFromHours(row.ageHours),
        formatUtcForReport(row.createdAtUtc)
      ]),
      emptyMessage: 'No active incidents.'
    });

    drawTable(doc, ctx, {
      title: `${windowLabel} by Space`,
      columns: [
        { header: 'Space', width: 333, wrap: true },
        { header: 'Incidents', width: 120, align: 'right', wrap: false }
      ],
      rows: deepDive.churn24h.bySpace.map((row) => [formatSpaceHierarchy(row.space), String(row.incidents)]),
      emptyMessage: 'No churn events in this window.'
    });

    drawTable(doc, ctx, {
      title: 'Oldest Open Tickets',
      columns: [
        { header: 'Ticket', width: 78, wrap: false },
        { header: 'Title', width: 108, wrap: true },
        { header: 'Age', width: 82, align: 'right', wrap: false },
        { header: 'Device', width: 84, wrap: false },
        { header: 'Created At (UTC)', width: 101, wrap: true }
      ],
      rows: deepDive.ticketPosture.oldestOpenTickets.map((row) => [
        compactIdentifier(redactSensitive(row.ticketId, includeSensitive)),
        row.title,
        formatRelativeAgeFromHours(row.ageHours),
        compactIdentifier(redactSensitive(row.deviceId, includeSensitive)),
        formatUtcForReport(row.createdAtUtc)
      ]),
      emptyMessage: 'No open tickets.'
    });

    if (deepDive.dataQuality.statusMismatches.length) {
      drawTable(doc, ctx, {
        title: 'Data Quality: Status Mismatches',
        columns: [
          { header: 'Device', width: 74, wrap: true },
          { header: 'Status', width: 70, wrap: false },
          { header: 'State', width: 86, wrap: false },
          { header: 'Last Seen (UTC)', width: 108, wrap: true },
          { header: 'Space', width: 115, wrap: true }
        ],
        rows: deepDive.dataQuality.statusMismatches.map((row) => [
          compactIdentifier(row.device),
          row.status,
          row.stateStatus,
          formatUtcForReport(row.lastSeen),
          formatSpaceHierarchy(row.space)
        ]),
        getCellTextColor: ({ columnIndex, value }) => {
          if (columnIndex !== 1 && columnIndex !== 2) {
            return undefined;
          }
          const normalized = value.toLowerCase();
          if (normalized === 'online') {
            return REPORT_THEME.status.online;
          }
          if (normalized === 'offline') {
            return REPORT_THEME.status.offline;
          }
          return undefined;
        }
      });
    }

    drawEndOfReportDivider(doc);

    const pages = doc.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index += 1) {
      doc.switchToPage(index);
      drawPdfFooter(doc, ctx, index - pages.start + 1, pages.count);
    }

    doc.end();
  });
}
