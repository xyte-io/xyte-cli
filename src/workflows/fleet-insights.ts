import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import PDFDocument from 'pdfkit';

import { extractArray } from '../tui/data-loaders';
import type { XyteClient } from '../types/client';
import { INSPECT_DEEP_DIVE_SCHEMA_VERSION, INSPECT_FLEET_SCHEMA_VERSION, REPORT_SCHEMA_VERSION } from '../contracts/versions';
import { withSpan } from '../observability/tracing';

interface StatusCounts {
  [key: string]: number;
}

export interface FleetSnapshot {
  generatedAtUtc: string;
  tenantId: string;
  devices: any[];
  spaces: any[];
  incidents: any[];
  tickets: any[];
}

export interface FleetInspectResult {
  schemaVersion: typeof INSPECT_FLEET_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId: string;
  totals: {
    devices: number;
    spaces: number;
    incidents: number;
    tickets: number;
  };
  status: {
    devices: StatusCounts;
    incidents: StatusCounts;
    tickets: StatusCounts;
    spaces: StatusCounts;
  };
  highlights: {
    offlineDevices: number;
    offlinePct: number;
    activeIncidents: number;
    activeIncidentPct: number;
    openTickets: number;
  };
}

export interface DeepDiveResult {
  schemaVersion: typeof INSPECT_DEEP_DIVE_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId: string;
  windowHours: number;
  summary: string[];
  topOfflineSpaces: Array<{ space: string; offlineDevices: number; shareOfOfflinePct: number }>;
  topIncidentDevices: Array<{ device: string; incidentCount: number; activeIncidents: number }>;
  activeIncidentAging: Array<{ device: string; space: string; ageHours: number; createdAtUtc: string }>;
  churn24h: {
    incidents: number;
    devices: number;
    spaces: number;
    bySpace: Array<{ space: string; incidents: number }>;
    byDevice: Array<{ device: string; incidents: number }>;
  };
  ticketPosture: {
    openTickets: number;
    overlappingActiveIncidentDevices: number;
    oldestOpenTickets: Array<{ ticketId: string; title: string; ageHours: number; deviceId: string; createdAtUtc: string }>;
  };
  dataQuality: {
    statusMismatches: Array<{ device: string; status: string; stateStatus: string; lastSeen: string; space: string }>;
  };
}

export interface FleetReportResult {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId: string;
  format: 'markdown' | 'pdf';
  outputPath: string;
  includeSensitive: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toCounter(items: string[]): StatusCounts {
  const counter: StatusCounts = {};
  for (const item of items) {
    counter[item] = (counter[item] ?? 0) + 1;
  }
  return counter;
}

function pct(count: number, total: number): number {
  if (!total) {
    return 0;
  }
  return Number(((count * 100) / total).toFixed(1));
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

  // Treat timezone-naive ISO timestamps as UTC for deterministic reporting.
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

function ageHours(createdAt: unknown): number {
  const parsed = parseTimestamp(createdAt);
  if (!parsed) {
    return 0;
  }
  const now = Date.now();
  return Math.max(0, Math.round((now - parsed.getTime()) / 3_600_000));
}

function topEntries(counter: Record<string, number>, limit = 10): Array<[string, number]> {
  return Object.entries(counter)
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit);
}

function identifier(value: unknown): string {
  if (value === undefined || value === null) {
    return 'n/a';
  }
  return String(value);
}

function safeSpacePath(value: any): string {
  return identifier(value?.space_tree_path_name ?? value?.space?.full_path ?? value?.space?.name ?? value?.space_id ?? 'unknown');
}

function safeDeviceName(value: any): string {
  return identifier(value?.device_name ?? value?.name ?? value?.device?.name ?? value?.device_id ?? 'unknown');
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

async function loadAllDevices(client: XyteClient, tenantId: string): Promise<any[]> {
  const perPage = 100;

  async function fetchAll(fetcher: (query: Record<string, any>) => Promise<any>): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const raw = await fetcher({ page, per_page: perPage });
      const pageItems = extractArray(raw, ['devices', 'data', 'items']);
      if (!pageItems.length) break;
      all.push(...pageItems);
      if (pageItems.length < perPage) break;
    }
    return all;
  }

  try {
    const devices = await fetchAll((q) => client.organization.getDevices({ tenantId, query: q }));
    if (devices.length > 0) return devices;
  } catch { /* fall through to partner */ }

  try {
    const devices = await fetchAll((q) => client.partner.getDevices({ tenantId, query: q }));
    if (devices.length > 0) return devices;
  } catch { /* fall through to unpaginated */ }

  const single = await client.organization.getDevices({ tenantId }).catch(() => client.partner.getDevices({ tenantId }));
  return extractArray(single, ['devices', 'data', 'items']);
}

async function loadAllSpaces(client: XyteClient, tenantId: string): Promise<any[]> {
  const perPage = 100;
  const all: any[] = [];

  for (let page = 1; page <= 50; page += 1) {
    const raw = await client.organization.getSpaces({
      tenantId,
      query: { page, per_page: perPage }
    });
    const pageItems = extractArray(raw, ['spaces', 'data', 'items']);
    if (!pageItems.length) {
      break;
    }
    all.push(...pageItems);
    if (pageItems.length < perPage) {
      break;
    }
  }

  if (all.length > 0) {
    return all;
  }

  const single = await client.organization.getSpaces({ tenantId });
  return extractArray(single, ['spaces', 'data', 'items']);
}

export async function collectFleetSnapshot(client: XyteClient, tenantId: string): Promise<FleetSnapshot> {
  return withSpan('xyte.inspect.collect_snapshot', { 'xyte.tenant.id': tenantId }, async () => {
    const [devices, spaces, incidentsRaw, orgTicketsRaw, partnerTicketsRaw] = await Promise.all([
      loadAllDevices(client, tenantId),
      loadAllSpaces(client, tenantId),
      client.organization.getIncidents({ tenantId }),
      client.organization.getTickets({ tenantId }).catch(() => ({ items: [] })),
      client.partner.getTickets({ tenantId }).catch(() => ({ items: [] }))
    ]);
    const incidents = extractArray(incidentsRaw, ['incidents', 'data', 'items']);
    const orgTickets = extractArray(orgTicketsRaw, ['tickets', 'data', 'items']);
    const partnerTickets = extractArray(partnerTicketsRaw, ['tickets', 'data', 'items']);
    const tickets = [...orgTickets, ...partnerTickets];

    const stableSort = (items: any[]) =>
      items.slice().sort((a, b) => identifier(a?.id ?? a?.name ?? a?.title).localeCompare(identifier(b?.id ?? b?.name ?? b?.title)));

    return {
      generatedAtUtc: new Date().toISOString(),
      tenantId,
      devices: stableSort(devices),
      spaces: stableSort(spaces),
      incidents: stableSort(incidents),
      tickets: stableSort(tickets)
    };
  });
}

export function buildFleetInspect(snapshot: FleetSnapshot): FleetInspectResult {
  const deviceStatus = toCounter(snapshot.devices.map((item) => identifier(item?.status ?? 'unknown')));
  const incidentStatus = toCounter(snapshot.incidents.map((item) => identifier(item?.status ?? 'unknown')));
  const ticketStatus = toCounter(snapshot.tickets.map((item) => identifier(item?.status ?? 'unknown')));
  const spaceTypes = toCounter(snapshot.spaces.map((item) => identifier(item?.space_type ?? 'unknown')));

  const offlineDevices = deviceStatus.offline ?? 0;
  const activeIncidents = incidentStatus.active ?? 0;
  const openTickets = ticketStatus.open ?? 0;

  return {
    schemaVersion: INSPECT_FLEET_SCHEMA_VERSION,
    generatedAtUtc: snapshot.generatedAtUtc,
    tenantId: snapshot.tenantId,
    totals: {
      devices: snapshot.devices.length,
      spaces: snapshot.spaces.length,
      incidents: snapshot.incidents.length,
      tickets: snapshot.tickets.length
    },
    status: {
      devices: deviceStatus,
      incidents: incidentStatus,
      tickets: ticketStatus,
      spaces: spaceTypes
    },
    highlights: {
      offlineDevices,
      offlinePct: pct(offlineDevices, snapshot.devices.length),
      activeIncidents,
      activeIncidentPct: pct(activeIncidents, snapshot.incidents.length),
      openTickets
    }
  };
}

function asciiBar(label: string, count: number, total: number, width = 30): string {
  const share = total > 0 ? count / total : 0;
  const filled = Math.min(width, Math.max(0, Math.round(share * width)));
  const bar = `${'#'.repeat(filled)}${' '.repeat(width - filled)}`;
  return `${label.padEnd(12)} ${String(count).padStart(4)} |${bar}| ${String((share * 100).toFixed(1)).padStart(5)}%`;
}

export function formatFleetInspectAscii(result: FleetInspectResult): string {
  return [
    `Fleet Inspect Snapshot (${result.tenantId})`,
    `Generated: ${result.generatedAtUtc}`,
    '',
    'DEVICES',
    asciiBar('offline', result.status.devices.offline ?? 0, result.totals.devices),
    asciiBar('online', result.status.devices.online ?? 0, result.totals.devices),
    asciiBar('other', result.totals.devices - (result.status.devices.offline ?? 0) - (result.status.devices.online ?? 0), result.totals.devices),
    '',
    'INCIDENTS',
    asciiBar('active', result.status.incidents.active ?? 0, result.totals.incidents),
    asciiBar('closed', result.status.incidents.closed ?? 0, result.totals.incidents),
    '',
    'TICKETS',
    asciiBar('open', result.status.tickets.open ?? 0, Math.max(1, result.totals.tickets)),
    '',
    `Highlights: offline=${result.highlights.offlinePct}% active_incidents=${result.highlights.activeIncidentPct}% open_tickets=${result.highlights.openTickets}`
  ].join('\n');
}

export function buildDeepDive(snapshot: FleetSnapshot, windowHours = 24): DeepDiveResult {
  const offlineDevices = snapshot.devices.filter((item) => identifier(item?.status) === 'offline');
  const activeIncidents = snapshot.incidents.filter((item) => identifier(item?.status) === 'active');
  const openTickets = snapshot.tickets.filter((item) => identifier(item?.status) === 'open');

  const offlineBySpace = toCounter(offlineDevices.map((item) => safeSpacePath(item)));
  const incidentsByDevice = toCounter(snapshot.incidents.map((item) => safeDeviceName(item)));
  const activeByDevice = toCounter(activeIncidents.map((item) => safeDeviceName(item)));

  const recentIncidents = snapshot.incidents.filter((item) => ageHours(item?.created_at) <= windowHours);
  const recentSpace = toCounter(recentIncidents.map((item) => safeSpacePath(item)));
  const recentDevice = toCounter(recentIncidents.map((item) => safeDeviceName(item)));

  const activeDeviceIds = new Set(activeIncidents.map((item) => identifier(item?.device_id ?? item?.device?.id)));
  const overlapDevices = new Set(openTickets.map((item) => identifier(item?.device_id)).filter((id) => activeDeviceIds.has(id)));

  const mismatches = snapshot.devices
    .map((item) => {
      const nestedState = asRecord(item?.state).status;
      if (nestedState === undefined) {
        return undefined;
      }
      const topLevel = identifier(item?.status);
      const nested = identifier(nestedState);
      if (topLevel === nested) {
        return undefined;
      }
      return {
        device: safeDeviceName(item),
        status: topLevel,
        stateStatus: nested,
        lastSeen: identifier(item?.last_seen_at),
        space: safeSpacePath(item)
      };
    })
    .filter((item): item is { device: string; status: string; stateStatus: string; lastSeen: string; space: string } => Boolean(item))
    .sort((a, b) => a.device.localeCompare(b.device));

  const topOfflineSpaces = topEntries(offlineBySpace, 10).map(([space, count]) => ({
    space,
    offlineDevices: count,
    shareOfOfflinePct: pct(count, offlineDevices.length)
  }));

  const topIncidentDevices = topEntries(incidentsByDevice, 10).map(([device, count]) => ({
    device,
    incidentCount: count,
    activeIncidents: activeByDevice[device] ?? 0
  }));

  const activeIncidentAging = activeIncidents
    .map((item) => ({
      device: safeDeviceName(item),
      space: safeSpacePath(item),
      ageHours: ageHours(item?.created_at),
      createdAtUtc: identifier(item?.created_at)
    }))
    .sort((a, b) => b.ageHours - a.ageHours);

  const oldestOpenTickets = openTickets
    .map((item) => ({
      ticketId: identifier(item?.id),
      title: identifier(item?.title ?? item?.subject),
      ageHours: ageHours(item?.created_at),
      deviceId: identifier(item?.device_id),
      createdAtUtc: identifier(item?.created_at)
    }))
    .sort((a, b) => b.ageHours - a.ageHours)
    .slice(0, 20);

  const summary = [
    `Devices: ${snapshot.devices.length} total, ${offlineDevices.length} offline (${pct(offlineDevices.length, snapshot.devices.length)}%).`,
    `Incidents: ${snapshot.incidents.length} total, ${activeIncidents.length} active (${pct(activeIncidents.length, snapshot.incidents.length)}%).`,
    `Tickets: ${snapshot.tickets.length} total, ${openTickets.length} open.`,
    `${windowHours}h churn: ${recentIncidents.length} incidents across ${Object.keys(recentDevice).length} devices and ${Object.keys(recentSpace).length} spaces.`,
    `Data quality: ${mismatches.length} status mismatches detected.`
  ];

  return {
    schemaVersion: INSPECT_DEEP_DIVE_SCHEMA_VERSION,
    generatedAtUtc: snapshot.generatedAtUtc,
    tenantId: snapshot.tenantId,
    windowHours,
    summary,
    topOfflineSpaces,
    topIncidentDevices,
    activeIncidentAging,
    churn24h: {
      incidents: recentIncidents.length,
      devices: Object.keys(recentDevice).length,
      spaces: Object.keys(recentSpace).length,
      bySpace: topEntries(recentSpace, 10).map(([space, incidents]) => ({ space, incidents })),
      byDevice: topEntries(recentDevice, 10).map(([device, incidents]) => ({ device, incidents }))
    },
    ticketPosture: {
      openTickets: openTickets.length,
      overlappingActiveIncidentDevices: overlapDevices.size,
      oldestOpenTickets
    },
    dataQuality: {
      statusMismatches: mismatches
    }
  };
}

export function formatDeepDiveAscii(result: DeepDiveResult): string {
  const lines: string[] = [];
  lines.push(`Deep Dive (${result.tenantId})`);
  lines.push(`Generated: ${result.generatedAtUtc}`);
  lines.push('');
  lines.push('SUMMARY');
  result.summary.forEach((line) => lines.push(`- ${line}`));
  lines.push('');
  lines.push('TOP OFFLINE SPACES');
  result.topOfflineSpaces.forEach((row) => lines.push(`${row.space} | offline=${row.offlineDevices} | share=${row.shareOfOfflinePct}%`));
  lines.push('');
  lines.push('TOP INCIDENT DEVICES');
  result.topIncidentDevices.forEach((row) =>
    lines.push(`${row.device} | incidents=${row.incidentCount} | active=${row.activeIncidents}`)
  );
  lines.push('');
  lines.push(`24H CHURN: incidents=${result.churn24h.incidents} devices=${result.churn24h.devices} spaces=${result.churn24h.spaces}`);
  result.churn24h.bySpace.forEach((row) => lines.push(`space: ${row.space} -> ${row.incidents}`));
  lines.push('');
  lines.push(`OPEN TICKETS: ${result.ticketPosture.openTickets}`);
  lines.push(`OVERLAP DEVICES: ${result.ticketPosture.overlappingActiveIncidentDevices}`);
  return lines.join('\n');
}

export function formatDeepDiveMarkdown(result: DeepDiveResult, includeSensitive = false): string {
  const markdown: string[] = [];
  markdown.push('# Xyte Fleet Deep Dive');
  markdown.push('');
  markdown.push(`- Tenant: \`${result.tenantId}\``);
  markdown.push(`- Generated: \`${result.generatedAtUtc}\``);
  markdown.push(`- Window: \`${result.windowHours}h\``);
  markdown.push('');
  markdown.push('## Summary');
  markdown.push('');
  result.summary.forEach((line) => markdown.push(`- ${line}`));
  markdown.push('');
  markdown.push('## Top Offline Spaces');
  markdown.push('');
  markdown.push('| Space | Offline Devices | Share |');
  markdown.push('| --- | ---: | ---: |');
  result.topOfflineSpaces.forEach((row) => markdown.push(`| ${row.space} | ${row.offlineDevices} | ${row.shareOfOfflinePct}% |`));
  markdown.push('');
  markdown.push('## Top Devices by Incident Volume');
  markdown.push('');
  markdown.push('| Device | Incidents | Active |');
  markdown.push('| --- | ---: | ---: |');
  result.topIncidentDevices.forEach((row) => markdown.push(`| ${row.device} | ${row.incidentCount} | ${row.activeIncidents} |`));
  markdown.push('');
  markdown.push(`## ${result.windowHours}-Hour Churn`);
  markdown.push('');
  markdown.push(
    `Incidents: **${result.churn24h.incidents}**, devices: **${result.churn24h.devices}**, spaces: **${result.churn24h.spaces}**.`
  );
  markdown.push('');
  markdown.push('| Space | Incidents |');
  markdown.push('| --- | ---: |');
  result.churn24h.bySpace.forEach((row) => markdown.push(`| ${row.space} | ${row.incidents} |`));
  markdown.push('');
  markdown.push('| Device | Incidents |');
  markdown.push('| --- | ---: |');
  result.churn24h.byDevice.forEach((row) => markdown.push(`| ${row.device} | ${row.incidents} |`));
  markdown.push('');
  markdown.push('## Ticket Posture');
  markdown.push('');
  markdown.push(`- Open tickets: **${result.ticketPosture.openTickets}**`);
  markdown.push(`- Overlapping active-incident devices: **${result.ticketPosture.overlappingActiveIncidentDevices}**`);
  markdown.push('');
  markdown.push('| Ticket ID | Title | Age (h) | Device ID | Created At |');
  markdown.push('| --- | --- | ---: | --- | --- |');
  result.ticketPosture.oldestOpenTickets.slice(0, 10).forEach((row) => {
    markdown.push(
      `| ${redactSensitive(row.ticketId, includeSensitive)} | ${row.title} | ${row.ageHours} | ${redactSensitive(
        row.deviceId,
        includeSensitive
      )} | ${row.createdAtUtc} |`
    );
  });
  markdown.push('');
  markdown.push('## Data Quality');
  markdown.push('');
  if (!result.dataQuality.statusMismatches.length) {
    markdown.push('No status mismatches detected.');
  } else {
    markdown.push('| Device | Status | state.status | Last Seen | Space |');
    markdown.push('| --- | --- | --- | --- | --- |');
    result.dataQuality.statusMismatches.forEach((row) =>
      markdown.push(`| ${row.device} | ${row.status} | ${row.stateStatus} | ${row.lastSeen} | ${row.space} |`)
    );
  }

  return markdown.join('\n');
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

const PAGE_MARGIN_X = 46;
const PAGE_MARGIN_Y = 42;
const HEADER_TOP = 18;
const HEADER_HEIGHT = 68;
const FOOTER_HEIGHT = 22;
const CONTENT_TOP = HEADER_TOP + HEADER_HEIGHT + 16;
const SPACE_SM = 8;
const SPACE_MD = 12;
const SPACE_LG = 18;
const SPACE_XL = 24;
const FONT_H1 = 18;
const FONT_H2 = 13;
const FONT_BODY = 10;
const FONT_CAPTION = 9;
const TABLE_ROW_MIN = 22;
const TABLE_ROW_MAX = 220;
const TABLE_CELL_PAD_X = 6;
const TABLE_CELL_PAD_Y = 5;

interface WindowFocus {
  label: string;
  detail: string;
  accent: string;
}

interface PdfRenderContext {
  tenantId: string;
  generatedAtUtc: string;
  windowHours: number;
  windowFocus: WindowFocus;
  logoPath?: string;
}

interface TableColumn {
  header: string;
  width: number;
  align?: 'left' | 'center' | 'right';
  wrap?: boolean;
}

function resolveLogoPath(): string | undefined {
  const candidates = [
    resolve(process.cwd(), 'assets/xyte-logo.png'),
    resolve(__dirname, '../../assets/xyte-logo.png'),
    resolve(__dirname, '../../../assets/xyte-logo.png')
  ];
  return candidates.find((candidate) => existsSync(candidate));
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

export function getWindowFocus(windowHours: number): WindowFocus {
  if (windowHours <= 24) {
    return {
      label: 'Immediate churn',
      detail: 'Prioritize active incident containment and hot spaces in the last day.',
      accent: '#B45309'
    };
  }
  if (windowHours <= 72) {
    return {
      label: 'Short-term Trend',
      detail: 'Track repeat offenders and stabilize recurring high-churn spaces.',
      accent: '#1D4ED8'
    };
  }
  return {
    label: 'Weekly concentration',
    detail: 'Focus on sustained incident concentration and structural remediation.',
    accent: '#166534'
  };
}

function resetCursor(doc: PDFKit.PDFDocument): void {
  doc.x = doc.page.margins.left;
  doc.y = Math.max(doc.y, CONTENT_TOP);
}

function drawPdfHeader(doc: PDFKit.PDFDocument, ctx: PdfRenderContext): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bandTop = HEADER_TOP;
  const bandHeight = HEADER_HEIGHT;

  doc.save();
  doc.roundedRect(left, bandTop, right - left, bandHeight, 8).fillAndStroke('#E8F0FC', '#C2D5F3');
  doc.restore();

  if (ctx.logoPath) {
    try {
      doc.image(ctx.logoPath, left + 12, bandTop + 16, { fit: [110, 34] });
    } catch {
      doc.font('Helvetica-Bold').fontSize(36).fillColor('#1459A6').text('XYTE', left + 12, bandTop + 12);
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(36).fillColor('#1459A6').text('XYTE', left + 12, bandTop + 12);
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(FONT_H1)
    .fillColor('#1A2332')
    .text('Fleet Findings Report', left + 146, bandTop + 14, { width: right - left - 250, align: 'left' });
  doc
    .font('Helvetica')
    .fontSize(FONT_BODY)
    .fillColor('#415067')
    .text(`Tenant: ${ctx.tenantId}`, left + 146, bandTop + 37, { width: right - left - 250, align: 'left' })
    .text(`Generated: ${formatUtcForReport(ctx.generatedAtUtc)}`, left + 146, bandTop + 51, { width: right - left - 250, align: 'left' });

  const badgeWidth = 165;
  const badgeHeight = 28;
  const badgeX = right - badgeWidth - 12;
  const badgeY = bandTop + 20;
  doc.save();
  doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 14).fill(ctx.windowFocus.accent);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(FONT_CAPTION).fillColor('#FFFFFF').text(
    `${ctx.windowHours}h • ${ctx.windowFocus.label}`,
    badgeX + 12,
    badgeY + 9,
    { width: badgeWidth - 24, align: 'center' }
  );
}

function drawPdfFooter(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, pageNumber: number, pageCount: number): void {
  const y = doc.page.height - doc.page.margins.bottom - FOOTER_HEIGHT + 10;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.save();
  doc.moveTo(left, y - 6).lineTo(right, y - 6).lineWidth(0.6).strokeColor('#D5DEE9').stroke();
  doc.restore();
  doc.font('Helvetica').fontSize(FONT_CAPTION).fillColor('#5B687B').text('Xyte Fleet Findings Report', left, y, { width: 220, align: 'left' });
  doc.text(`${ctx.windowHours}h window`, left + 220, y, { width: 120, align: 'center' });
  doc.text(`Page ${pageNumber} of ${pageCount}`, right - 120, y, { width: 120, align: 'right' });
}

function startReportPage(doc: PDFKit.PDFDocument, ctx: PdfRenderContext): void {
  doc.addPage();
  drawPdfHeader(doc, ctx);
  resetCursor(doc);
}

function ensurePageSpace(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, minHeight: number): void {
  resetCursor(doc);
  const bottom = doc.page.height - doc.page.margins.bottom - FOOTER_HEIGHT - SPACE_SM;
  if (doc.y + minHeight <= bottom) {
    return;
  }
  startReportPage(doc, ctx);
}

function drawSectionTitle(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, title: string): void {
  ensurePageSpace(doc, ctx, 30);
  resetCursor(doc);
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold').fontSize(FONT_H2).fillColor('#182433').text(title, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right
  });
  const y = doc.y + 2;
  doc.save();
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.8).strokeColor('#D4DEE8').stroke();
  doc.restore();
  doc.moveDown(0.2);
}

function drawWindowFocusStrip(doc: PDFKit.PDFDocument, ctx: PdfRenderContext): void {
  ensurePageSpace(doc, ctx, 56);
  resetCursor(doc);
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const height = 48;
  doc.save();
  doc.roundedRect(x, y, width, height, 7).fillAndStroke('#F3F7FC', '#D7E3F2');
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(FONT_BODY).fillColor(ctx.windowFocus.accent).text('Window Focus', x + 12, y + 10);
  doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#243447').text(ctx.windowFocus.detail, x + 110, y + 10, {
    width: width - 122
  });
  doc.y = y + height + SPACE_MD;
}

function drawKpiGrid(
  doc: PDFKit.PDFDocument,
  ctx: PdfRenderContext,
  cards: Array<{ label: string; value: string; tone?: 'normal' | 'warn' | 'bad' }>
): void {
  ensurePageSpace(doc, ctx, 106);
  resetCursor(doc);
  const startX = doc.page.margins.left;
  const topY = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = SPACE_SM;
  const cardWidth = Math.floor((width - gap * 3) / 4);
  const cardHeight = 84;

  cards.slice(0, 4).forEach((card, index) => {
    const x = startX + index * (cardWidth + gap);
    const tone =
      card.tone === 'bad'
        ? { bg: '#FDEBEC', border: '#F7C4C7', value: '#A2282F' }
        : card.tone === 'warn'
          ? { bg: '#FFF6E8', border: '#F7D9A6', value: '#9C5F08' }
          : { bg: '#EEF6FF', border: '#C6E0FF', value: '#1459A6' };

    doc.save();
    doc.roundedRect(x, topY, cardWidth, cardHeight, 8).fillAndStroke(tone.bg, tone.border);
    doc.restore();
    doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#4B5563').text(card.label, x + 10, topY + 13, {
      width: cardWidth - 20
    });
    doc.font('Helvetica-Bold').fontSize(26).fillColor(tone.value).text(card.value, x + 10, topY + 37, {
      width: cardWidth - 20
    });
  });

  doc.y = topY + cardHeight + SPACE_LG;
}

function drawKeyFindings(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, lines: string[]): void {
  const findings = lines.slice(0, 4);
  if (!findings.length) {
    return;
  }

  ensurePageSpace(doc, ctx, 72);
  resetCursor(doc);
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.save();
  doc.roundedRect(x, y, width, 56 + findings.length * 10, 8).fillAndStroke('#F8FAFD', '#DCE6F2');
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(FONT_BODY).fillColor('#223245').text('Key Findings', x + 12, y + 10);
  let cursorY = y + 26;
  findings.forEach((line) => {
    doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#1F2A38').text(`- ${line}`, x + 12, cursorY, {
      width: width - 24
    });
    cursorY += 14;
  });
  doc.y = y + 56 + findings.length * 10 + SPACE_LG;
}

function drawBullets(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, lines: string[]): void {
  lines.forEach((line) => {
    ensurePageSpace(doc, ctx, 20);
    resetCursor(doc);
    doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#1F2937').text(`- ${line}`, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right
    });
    doc.moveDown(0.05);
  });
}

function drawSpaceBars(doc: PDFKit.PDFDocument, ctx: PdfRenderContext, rows: Array<{ space: string; incidents: number }>): void {
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
    ensurePageSpace(doc, ctx, 24);
    resetCursor(doc);
    const y = doc.y;
    const x = doc.page.margins.left;
    const ratio = row.incidents / maxValue;
    doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#1F2937').text(row.space, x, y + 5, {
      width: labelWidth - 8,
      ellipsis: true
    });
    doc.save();
    doc.roundedRect(x + labelWidth, y + 8, barWidth, 9, 3).fill('#E6ECF5');
    doc.roundedRect(x + labelWidth, y + 8, Math.max(8, barWidth * ratio), 9, 3).fill('#3B82F6');
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(FONT_BODY).fillColor('#1F2937').text(String(row.incidents), x + labelWidth + barWidth + 8, y + 5, {
      width: valueWidth,
      align: 'right'
    });
    doc.y = y + 22;
  });
  doc.moveDown(0.35);
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
  doc.font('Helvetica').fontSize(FONT_BODY);
  const lineHeight = doc.currentLineHeight();
  let maxHeight = lineHeight;
  row.forEach((cell, index) => {
    const column = columns[index];
    const innerWidth = Math.max(20, column.width - TABLE_CELL_PAD_X * 2);
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
  const rowHeight = maxHeight + TABLE_CELL_PAD_Y * 2;
  return Math.min(TABLE_ROW_MAX, Math.max(TABLE_ROW_MIN, rowHeight));
}

function drawTable(
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
    resetCursor(doc);
    const y = doc.y;
    let x = tableLeft;
    columns.forEach((column) => {
      doc.save();
      doc.rect(x, y, column.width, headerHeight).fillAndStroke('#E8EEF6', '#CAD7E8');
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(FONT_BODY).fillColor('#1F2937').text(column.header, x + TABLE_CELL_PAD_X, y + 6, {
        width: column.width - TABLE_CELL_PAD_X * 2,
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
    resetCursor(doc);
    doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#475569').text(args.emptyMessage ?? 'No data available.', {
      width: availableWidth
    });
    doc.moveDown(0.5);
    return;
  }

  const firstRowHeight = measureTableRowHeight(doc, columns, args.rows[0]);
  ensurePageSpace(doc, ctx, 34 + headerHeight + firstRowHeight);
  drawSectionTitle(doc, ctx, args.title);
  drawHeader();
  args.rows.forEach((row) => {
    const rowHeight = measureTableRowHeight(doc, columns, row);
    const bottom = doc.page.height - doc.page.margins.bottom - FOOTER_HEIGHT - SPACE_SM;
    if (doc.y + rowHeight > bottom) {
      startReportPage(doc, ctx);
      ensurePageSpace(doc, ctx, 34 + headerHeight + Math.min(rowHeight, 60));
      drawSectionTitle(doc, ctx, continuationTitle);
      drawHeader();
    }

    const y = doc.y;
    let x = tableLeft;
    row.forEach((cell, index) => {
      const column = columns[index];
      doc.save();
      doc.rect(x, y, column.width, rowHeight).fillAndStroke('#FFFFFF', '#E3EAF3');
      doc.restore();
      doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#0F172A').text(cell, x + TABLE_CELL_PAD_X, y + TABLE_CELL_PAD_Y, {
        width: column.width - TABLE_CELL_PAD_X * 2,
        height: rowHeight - TABLE_CELL_PAD_Y * 2,
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

function renderBrandedPdfReport(deepDive: DeepDiveResult, outputPath: string, includeSensitive: boolean): Promise<void> {
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
        left: PAGE_MARGIN_X,
        right: PAGE_MARGIN_X,
        top: PAGE_MARGIN_Y,
        bottom: PAGE_MARGIN_Y
      },
      bufferPages: true
    });
    const stream = doc.pipe(createWriteStream(outputPath));

    stream.on('finish', () => resolvePromise());
    stream.on('error', (error) => rejectPromise(error));

    drawPdfHeader(doc, ctx);
    resetCursor(doc);

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
export async function generateFleetReport(args: {
  deepDive: DeepDiveResult;
  format: 'markdown' | 'pdf';
  outPath: string;
  includeSensitive: boolean;
}): Promise<FleetReportResult> {
  const markdown = formatDeepDiveMarkdown(args.deepDive, args.includeSensitive);
  ensureDir(args.outPath);

  if (args.format === 'markdown') {
    writeFileSync(args.outPath, markdown, 'utf8');
  } else {
    await renderBrandedPdfReport(args.deepDive, args.outPath, args.includeSensitive);
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.deepDive.tenantId,
    format: args.format,
    outputPath: resolve(args.outPath),
    includeSensitive: args.includeSensitive
  };
}
