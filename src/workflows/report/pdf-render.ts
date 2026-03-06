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
  drawInsightPanelGrid,
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
  if (parts.length <= 1) {
    return value;
  }
  if (parts.length === 2) {
    return parts[1] ?? value;
  }

  const leaf = parts.at(-1) ?? value;
  const context = parts.slice(Math.max(0, parts.length - 3), parts.length - 1);
  if (!context.length) {
    return leaf;
  }
  return `${leaf} (${context.join(' / ')})`;
}

interface DeepDiveReportSectionPlan {
  includeOfflineSpaces: boolean;
  includeIncidentSections: boolean;
  includeTicketSection: boolean;
  includeTicketTable: boolean;
  includeDataQualitySection: boolean;
}

interface DeepDiveSummaryPlan {
  executiveSummary: string[];
  partnerHighlights: string[];
}

interface KpiCardPlan {
  label: string;
  value: string;
  detail?: string;
  tone?: 'normal' | 'warn' | 'bad';
}

interface InsightCardPlan {
  eyebrow: string;
  title: string;
  body: string;
  tone?: 'accent' | 'normal' | 'warn' | 'bad' | 'success';
}

interface DeepDiveOverviewPlan {
  kpis: KpiCardPlan[];
  insights: InsightCardPlan[];
}

interface DeepDiveSummaryMetrics {
  totalDevices: number;
  offlineDevices: number;
  offlinePct: number;
  totalIncidents: number;
  activeIncidents: number;
  activeIncidentPct: number;
  totalTickets: number;
  openTickets: number;
  mismatches: number;
}

function getDeepDiveSummaryMetrics(deepDive: DeepDiveResult): DeepDiveSummaryMetrics {
  return {
    totalDevices: deepDive.overviewMetrics?.totalDevices ?? 0,
    offlineDevices: deepDive.overviewMetrics?.offlineDevices ?? 0,
    offlinePct: deepDive.overviewMetrics?.offlinePct ?? 0,
    totalIncidents: deepDive.overviewMetrics?.totalIncidents ?? 0,
    activeIncidents: deepDive.overviewMetrics?.activeIncidents ?? 0,
    activeIncidentPct: deepDive.overviewMetrics?.activeIncidentPct ?? 0,
    totalTickets: deepDive.overviewMetrics?.totalTickets ?? 0,
    openTickets: deepDive.overviewMetrics?.openTickets ?? 0,
    mismatches: deepDive.overviewMetrics?.statusMismatches ?? 0
  };
}

function formatSpotlightDevice(value: string): string {
  const compact = compactIdentifier(value);
  return compact || 'n/a';
}

function shortenSpotlightTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'n/a';
  }
  const slashIndex = trimmed.lastIndexOf('/');
  const fallbackLeaf = slashIndex >= 0 ? trimmed.slice(slashIndex + 1).trim() : trimmed;
  if (!trimmed.endsWith(')')) {
    return fallbackLeaf || trimmed;
  }
  const suffixStart = trimmed.lastIndexOf(' (');
  if (suffixStart <= 0) {
    return fallbackLeaf || trimmed;
  }
  const suffix = trimmed.slice(suffixStart + 2, -1).trim();
  if (!suffix) {
    return fallbackLeaf || trimmed;
  }
  const base = trimmed.slice(0, suffixStart).trim();
  const baseSlashIndex = base.lastIndexOf('/');
  if (baseSlashIndex >= 0) {
    return base.slice(baseSlashIndex + 1).trim() || base;
  }
  return base;
}

export function buildDeepDiveOverviewPlan(deepDive: DeepDiveResult): DeepDiveOverviewPlan {
  const metrics = getDeepDiveSummaryMetrics(deepDive);
  const windowFocus = getWindowFocus(deepDive.windowHours);
  const topOfflineSpace = deepDive.topOfflineSpaces[0];
  const topIncidentDevice = deepDive.topIncidentDevices[0];
  const overlapDevices = deepDive.ticketPosture.overlappingActiveIncidentDevices;
  const churnTone: 'normal' | 'warn' | 'bad' =
    deepDive.churn24h.incidents >= 10 ? 'bad' : deepDive.churn24h.incidents > 0 ? 'warn' : 'normal';
  const dataQualityTone: 'normal' | 'warn' | 'bad' = metrics.mismatches > 0 ? 'warn' : 'normal';

  const offlineTone: 'normal' | 'warn' | 'bad' =
    metrics.offlinePct >= 45 ? 'bad' : metrics.offlinePct >= 20 ? 'warn' : 'normal';
  const incidentTone: 'normal' | 'warn' | 'bad' =
    metrics.activeIncidents >= 25 ? 'bad' : metrics.activeIncidents > 0 ? 'warn' : 'normal';
  const ticketTone: 'normal' | 'warn' | 'bad' =
    metrics.openTickets >= 10 ? 'bad' : metrics.openTickets > 0 ? 'warn' : 'normal';

  const kpis: KpiCardPlan[] = [
    {
      label: 'Total devices',
      value: String(metrics.totalDevices),
      detail: metrics.totalDevices > 0 ? `${metrics.offlineDevices} currently offline` : 'No device inventory returned.'
    },
    {
      label: 'Offline devices',
      value: String(metrics.offlineDevices),
      detail: `${metrics.offlinePct}% of fleet`,
      tone: offlineTone
    },
    deepDive.topIncidentDevices.length > 0 || metrics.activeIncidents > 0
      ? {
          label: 'Active incidents',
          value: String(metrics.activeIncidents),
          detail: metrics.totalIncidents > 0 ? `${metrics.activeIncidentPct}% of incident volume` : 'No incident baseline returned.',
          tone: incidentTone
        }
      : {
          label: 'Report window',
          value: `${deepDive.windowHours}h`,
          detail: windowFocus.label,
          tone: 'normal'
        },
    {
      label: 'Open tickets',
      value: String(metrics.openTickets),
      detail: overlapDevices > 0 ? `${overlapDevices} devices overlap incidents` : 'No ticket overlap detected.',
      tone: ticketTone
    },
    {
      label: deepDive.windowHours <= 24 ? '24h churn' : 'Window churn',
      value: String(deepDive.churn24h.incidents),
      detail: `${deepDive.churn24h.devices} devices in ${deepDive.churn24h.spaces} spaces`,
      tone: churnTone
    },
    {
      label: 'Data quality',
      value: String(metrics.mismatches),
      detail: metrics.mismatches > 0 ? 'State mismatches detected' : 'No status mismatches',
      tone: dataQualityTone
    }
  ];

  const insights: InsightCardPlan[] = [
    {
      eyebrow: 'Focus',
      title: windowFocus.label,
      body: windowFocus.detail,
      tone: 'accent'
    },
    topOfflineSpace
      ? {
          eyebrow: 'Space hotspot',
          title: shortenSpotlightTitle(formatSpaceHierarchy(topOfflineSpace.space)),
          body: `${topOfflineSpace.offlineDevices} offline devices, accounting for ${topOfflineSpace.shareOfOfflinePct}% of all offline inventory.`,
          tone: topOfflineSpace.shareOfOfflinePct >= 50 ? 'bad' : 'warn'
        }
      : {
          eyebrow: 'Space hotspot',
          title: 'No offline concentration',
          body: 'No single space is dominating the offline population in this snapshot.',
          tone: 'success'
        },
    topIncidentDevice
      ? {
          eyebrow: 'Response posture',
          title: formatSpotlightDevice(topIncidentDevice.device),
          body:
            topIncidentDevice.activeIncidents > 0
              ? `${topIncidentDevice.activeIncidents} active incidents remain on the busiest device. ${metrics.openTickets} open tickets are still open overall, with ${overlapDevices} devices overlapping incidents and tickets.`
              : `${topIncidentDevice.incidentCount} historical incidents on the busiest device. ${metrics.openTickets} tickets remain open overall, with ${overlapDevices} overlapping devices.`,
          tone: overlapDevices > 0 || topIncidentDevice.activeIncidents > 0 ? 'warn' : 'normal'
        }
      : {
          eyebrow: 'Data quality',
          title: metrics.mismatches > 0 ? `${metrics.mismatches} mismatches need review` : 'No status mismatches detected',
          body:
            metrics.mismatches > 0
              ? 'Device status and state disagree for part of the fleet. Review these before triage automation depends on them.'
              : 'Status and state alignment is clean in this snapshot, so downstream triage can trust the operational posture.',
          tone: metrics.mismatches > 0 ? 'warn' : 'success'
        }
  ];

  return {
    kpis,
    insights
  };
}

export function buildDeepDiveReportSectionPlan(deepDive: DeepDiveResult): DeepDiveReportSectionPlan {
  const includeIncidentSections =
    deepDive.topIncidentDevices.length > 0 ||
    deepDive.activeIncidentAging.length > 0 ||
    deepDive.churn24h.incidents > 0 ||
    deepDive.churn24h.bySpace.length > 0 ||
    deepDive.churn24h.byDevice.length > 0;

  return {
    includeOfflineSpaces: deepDive.topOfflineSpaces.length > 0,
    includeIncidentSections,
    includeTicketSection: deepDive.ticketPosture.openTickets > 0 || deepDive.ticketPosture.oldestOpenTickets.length > 0,
    includeTicketTable: deepDive.ticketPosture.oldestOpenTickets.length > 0,
    includeDataQualitySection: deepDive.dataQuality.statusMismatches.length > 0
  };
}

export function buildDeepDiveSummaryPlan(deepDive: DeepDiveResult): DeepDiveSummaryPlan {
  const windowLabel = formatWindowLabel(deepDive.windowHours);
  const dedupedSummary = Array.from(
    new Set(
      deepDive.summary
        .map((line) => line.replace(/^(\d+)h churn:/i, `${windowLabel} churn:`).trim())
        .filter(Boolean)
    )
  );

  const partnerHighlights = dedupedSummary.filter((line) => line.startsWith('Partner '));
  const executiveSummary = dedupedSummary.filter((line) => !line.startsWith('Partner '));

  return {
    executiveSummary: executiveSummary.length > 0 ? executiveSummary : dedupedSummary,
    partnerHighlights
  };
}

export function renderBrandedPdfReport(deepDive: DeepDiveResult, outputPath: string, includeSensitive: boolean): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    ensureDir(outputPath);
    const sectionPlan = buildDeepDiveReportSectionPlan(deepDive);
    const windowLabel = formatWindowLabel(deepDive.windowHours);
    const summaryPlan = buildDeepDiveSummaryPlan(deepDive);
    const overviewPlan = buildDeepDiveOverviewPlan(deepDive);

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

    drawKpiGrid(doc, ctx, overviewPlan.kpis);
    drawInsightPanelGrid(doc, ctx, overviewPlan.insights);

    drawSectionTitle(doc, ctx, 'Executive Summary');
    drawBullets(doc, ctx, summaryPlan.executiveSummary);
    doc.y += PDF_LAYOUT.sectionGap;

    if (summaryPlan.partnerHighlights.length > 0) {
      drawSectionTitle(doc, ctx, 'Partner Highlights');
      drawBullets(doc, ctx, summaryPlan.partnerHighlights);
    }
    doc.y += PDF_LAYOUT.sectionGap;

    if (sectionPlan.includeIncidentSections) {
      drawSpaceBars(
        doc,
        ctx,
        deepDive.churn24h.bySpace.map((row) => ({
          space: formatSpaceHierarchy(row.space),
          incidents: row.incidents
        }))
      );
    }

    if (sectionPlan.includeOfflineSpaces) {
      drawTable(doc, ctx, {
        title: 'Offline Device Concentration',
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
    }

    if (sectionPlan.includeIncidentSections) {
      drawTable(doc, ctx, {
        title: 'Incident Hotspots by Device',
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
        title: 'Aging Active Incidents',
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

      if (deepDive.churn24h.bySpace.length > 0) {
        drawTable(doc, ctx, {
          title: `${windowLabel} Churn by Space`,
          columns: [
            { header: 'Space', width: 333, wrap: true },
            { header: 'Incidents', width: 120, align: 'right', wrap: false }
          ],
          rows: deepDive.churn24h.bySpace.map((row) => [formatSpaceHierarchy(row.space), String(row.incidents)]),
          emptyMessage: 'No churn events in this window.'
        });
      }
    }

    if (sectionPlan.includeTicketTable) {
      drawTable(doc, ctx, {
        title: 'Ticket Backlog',
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
    }

    if (sectionPlan.includeDataQualitySection) {
      drawTable(doc, ctx, {
        title: 'Data Quality Mismatches',
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
