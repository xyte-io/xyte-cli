import { createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import PDFDocument from 'pdfkit';

import type { DeepDiveResult } from '../fleet-insights';
import { drawTable } from './pdf-table';
import {
  PDF_LAYOUT,
  drawBullets,
  drawKeyFindings,
  drawKpiGrid,
  drawPdfFooter,
  drawPdfHeader,
  drawSectionTitle,
  drawSpaceBars,
  drawWindowFocusStrip,
  formatUtcForReport,
  resolveLogoPath,
  type PdfRenderContext
} from './pdf-layout';
import { getWindowFocus } from './theme';

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

export function renderBrandedPdfReport(deepDive: DeepDiveResult, outputPath: string, includeSensitive: boolean): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    ensureDir(outputPath);
    const ctx: PdfRenderContext = {
      tenantId: deepDive.tenantId,
      generatedAtUtc: deepDive.generatedAtUtc,
      windowHours: deepDive.windowHours,
      windowFocus: getWindowFocus(deepDive.windowHours),
      logoPath: resolveLogoPath()
    };

    const doc = new PDFDocument({
      size: 'LETTER',
      margins: {
        left: PDF_LAYOUT.pageMarginX,
        right: PDF_LAYOUT.pageMarginX,
        top: PDF_LAYOUT.pageMarginY,
        bottom: PDF_LAYOUT.pageMarginY
      },
      bufferPages: true,
      compress: false
    });
    const stream = doc.pipe(createWriteStream(outputPath));

    stream.on('finish', () => resolvePromise());
    stream.on('error', (error) => rejectPromise(error));

    drawPdfHeader(doc, ctx);
    doc.y = Math.max(doc.y, PDF_LAYOUT.contentTop);

    drawKpiGrid(doc, ctx, [
      { label: 'Active incidents', value: String(deepDive.activeIncidentAging.length), tone: deepDive.activeIncidentAging.length > 0 ? 'warn' : 'normal' },
      { label: `${deepDive.windowHours}h churn`, value: String(deepDive.churn24h.incidents), tone: deepDive.churn24h.incidents > 0 ? 'warn' : 'normal' },
      { label: 'Open tickets', value: String(deepDive.ticketPosture.openTickets), tone: deepDive.ticketPosture.openTickets > 0 ? 'warn' : 'normal' },
      {
        label: 'Data mismatches',
        value: String(deepDive.dataQuality.statusMismatches.length),
        tone: deepDive.dataQuality.statusMismatches.length > 0 ? 'bad' : 'normal'
      }
    ]);

    drawWindowFocusStrip(doc, ctx);
    drawKeyFindings(doc, ctx, deepDive.summary);

    drawSectionTitle(doc, ctx, 'Executive Summary');
    drawBullets(doc, ctx, deepDive.summary);
    doc.moveDown(0.35);

    drawSpaceBars(doc, ctx, deepDive.churn24h.bySpace);

    drawTable(doc, ctx, {
      title: 'Top Spaces by Offline Devices',
      columns: [
        { header: 'Space', width: 370, wrap: true },
        { header: 'Offline', width: 90, align: 'right', wrap: false },
        { header: 'Share', width: 90, align: 'right', wrap: false }
      ],
      rows: deepDive.topOfflineSpaces.map((row) => [row.space, String(row.offlineDevices), `${row.shareOfOfflinePct}%`]),
      emptyMessage: 'No offline spaces found.'
    });

    drawTable(doc, ctx, {
      title: 'Top Devices by Incident Volume',
      columns: [
        { header: 'Device', width: 370, wrap: true },
        { header: 'Incidents', width: 90, align: 'right', wrap: false },
        { header: 'Active', width: 90, align: 'right', wrap: false }
      ],
      rows: deepDive.topIncidentDevices.map((row) => [row.device, String(row.incidentCount), String(row.activeIncidents)]),
      emptyMessage: 'No incident device concentration detected.'
    });

    drawTable(doc, ctx, {
      title: 'Active Incident Aging',
      columns: [
        { header: 'Device', width: 120, wrap: true },
        { header: 'Space', width: 230, wrap: true },
        { header: 'Age (h)', width: 70, align: 'right', wrap: false },
        { header: 'Created At', width: 130, wrap: false }
      ],
      rows: deepDive.activeIncidentAging.slice(0, 16).map((row) => [row.device, row.space, String(row.ageHours), formatUtcForReport(row.createdAtUtc)]),
      emptyMessage: 'No active incidents.'
    });

    drawTable(doc, ctx, {
      title: `${deepDive.windowHours}-Hour Churn by Space`,
      columns: [
        { header: 'Space', width: 450, wrap: true },
        { header: 'Incidents', width: 100, align: 'right', wrap: false }
      ],
      rows: deepDive.churn24h.bySpace.map((row) => [row.space, String(row.incidents)]),
      emptyMessage: 'No churn events in this window.'
    });

    drawTable(doc, ctx, {
      title: 'Oldest Open Tickets',
      columns: [
        { header: 'Ticket', width: 88, wrap: false },
        { header: 'Title', width: 182, wrap: true },
        { header: 'Age (h)', width: 62, align: 'right', wrap: false },
        { header: 'Device', width: 88, wrap: false },
        { header: 'Created At', width: 130, wrap: false }
      ],
      rows: deepDive.ticketPosture.oldestOpenTickets.slice(0, 12).map((row) => [
        redactSensitive(row.ticketId, includeSensitive),
        row.title,
        String(row.ageHours),
        redactSensitive(row.deviceId, includeSensitive),
        formatUtcForReport(row.createdAtUtc)
      ]),
      emptyMessage: 'No open tickets.'
    });

    if (deepDive.dataQuality.statusMismatches.length) {
      drawTable(doc, ctx, {
        title: 'Data Quality: Status Mismatches',
        columns: [
          { header: 'Device', width: 120, wrap: true },
          { header: 'status', width: 70, wrap: false },
          { header: 'state.status', width: 90, wrap: false },
          { header: 'Last Seen', width: 130, wrap: false },
          { header: 'Space', width: 160, wrap: true }
        ],
        rows: deepDive.dataQuality.statusMismatches.map((row) => [
          row.device,
          row.status,
          row.stateStatus,
          formatUtcForReport(row.lastSeen),
          row.space
        ])
      });
    }

    const pages = doc.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index += 1) {
      doc.switchToPage(index);
      drawPdfFooter(doc, ctx, index - pages.start + 1, pages.count);
    }

    doc.end();
  });
}
