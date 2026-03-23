import type { DeepDiveResult } from '../types/deep-dive';
import { redactForDisplay } from '../utils/redact';

import type { FleetInspectResult } from '../types/fleet-inspect';

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
    asciiBar(
      'other',
      result.totals.devices - (result.status.devices.offline ?? 0) - (result.status.devices.online ?? 0),
      result.totals.devices
    ),
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

export function formatDeepDiveAscii(result: DeepDiveResult): string {
  const hasOfflineSpaceData = result.topOfflineSpaces.length > 0;
  const hasIncidentData =
    result.topIncidentDevices.length > 0 ||
    result.activeIncidentAging.length > 0 ||
    result.churnWindow.incidents > 0 ||
    result.churnWindow.bySpace.length > 0 ||
    result.churnWindow.byDevice.length > 0;
  const hasTicketData = result.ticketPosture.openTickets > 0 || result.ticketPosture.oldestOpenTickets.length > 0;

  const lines: string[] = [];
  lines.push(`Deep Dive (${result.tenantId})`);
  lines.push(`Generated: ${result.generatedAtUtc}`);
  lines.push('');
  lines.push('SUMMARY');
  result.summary.forEach((line) => lines.push(`- ${line}`));

  if (hasOfflineSpaceData) {
    lines.push('');
    lines.push('TOP OFFLINE SPACES');
    result.topOfflineSpaces.forEach((row) =>
      lines.push(`${row.space} | offline=${row.offlineDevices} | share=${row.shareOfOfflinePct}%`)
    );
  }

  if (hasIncidentData) {
    lines.push('');
    lines.push('TOP INCIDENT DEVICES');
    result.topIncidentDevices.forEach((row) =>
      lines.push(`${row.device} | incidents=${row.incidentCount} | active=${row.activeIncidents}`)
    );
    lines.push('');
    lines.push(
      `${result.windowHours}H CHURN: incidents=${result.churnWindow.incidents} devices=${result.churnWindow.devices} spaces=${result.churnWindow.spaces}`
    );
    result.churnWindow.bySpace.forEach((row) => lines.push(`space: ${row.space} -> ${row.incidents}`));
  }

  if (hasTicketData) {
    lines.push('');
    lines.push(`OPEN TICKETS: ${result.ticketPosture.openTickets}`);
    if (hasIncidentData) {
      lines.push(`OVERLAP DEVICES: ${result.ticketPosture.overlappingActiveIncidentDevices}`);
    }
  }

  return lines.join('\n');
}

export function formatDeepDiveMarkdown(result: DeepDiveResult, includeSensitive = false): string {
  const hasOfflineSpaceData = result.topOfflineSpaces.length > 0;
  const hasIncidentData =
    result.topIncidentDevices.length > 0 ||
    result.activeIncidentAging.length > 0 ||
    result.churnWindow.incidents > 0 ||
    result.churnWindow.bySpace.length > 0 ||
    result.churnWindow.byDevice.length > 0;
  const hasTicketData = result.ticketPosture.openTickets > 0 || result.ticketPosture.oldestOpenTickets.length > 0;
  const hasDataQualityIssues = result.dataQuality.statusMismatches.length > 0;
  const partnerHighlights = result.summary.filter((line) => line.startsWith('Partner '));

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

  if (partnerHighlights.length > 0) {
    markdown.push('');
    markdown.push('## Partner Highlights');
    markdown.push('');
    partnerHighlights.forEach((line) => markdown.push(`- ${line}`));
  }

  if (hasOfflineSpaceData) {
    markdown.push('');
    markdown.push('## Top Offline Spaces');
    markdown.push('');
    markdown.push('| Space | Offline Devices | Share |');
    markdown.push('| --- | ---: | ---: |');
    result.topOfflineSpaces.forEach((row) =>
      markdown.push(`| ${row.space} | ${row.offlineDevices} | ${row.shareOfOfflinePct}% |`)
    );
  }

  if (hasIncidentData) {
    markdown.push('');
    markdown.push('## Top Devices by Incident Volume');
    markdown.push('');
    markdown.push('| Device | Incidents | Active |');
    markdown.push('| --- | ---: | ---: |');
    result.topIncidentDevices.forEach((row) =>
      markdown.push(`| ${row.device} | ${row.incidentCount} | ${row.activeIncidents} |`)
    );
    markdown.push('');
    markdown.push(`## ${result.windowHours}-Hour Churn`);
    markdown.push('');
    markdown.push(
      `Incidents: **${result.churnWindow.incidents}**, devices: **${result.churnWindow.devices}**, spaces: **${result.churnWindow.spaces}**.`
    );
    if (result.churnWindow.bySpace.length > 0) {
      markdown.push('');
      markdown.push('| Space | Incidents |');
      markdown.push('| --- | ---: |');
      result.churnWindow.bySpace.forEach((row) => markdown.push(`| ${row.space} | ${row.incidents} |`));
    }
    if (result.churnWindow.byDevice.length > 0) {
      markdown.push('');
      markdown.push('| Device | Incidents |');
      markdown.push('| --- | ---: |');
      result.churnWindow.byDevice.forEach((row) => markdown.push(`| ${row.device} | ${row.incidents} |`));
    }
  }

  if (hasTicketData) {
    markdown.push('');
    markdown.push('## Ticket Posture');
    markdown.push('');
    markdown.push(`- Open tickets: **${result.ticketPosture.openTickets}**`);
    if (hasIncidentData) {
      markdown.push(
        `- Overlapping active-incident devices: **${result.ticketPosture.overlappingActiveIncidentDevices}**`
      );
    }
    if (result.ticketPosture.oldestOpenTickets.length > 0) {
      markdown.push('');
      markdown.push('| Ticket ID | Title | Age (h) | Device ID | Created At |');
      markdown.push('| --- | --- | ---: | --- | --- |');
      result.ticketPosture.oldestOpenTickets.slice(0, 10).forEach((row) => {
        markdown.push(
          `| ${redactForDisplay(row.ticketId, includeSensitive)} | ${row.title} | ${row.ageHours} | ${redactForDisplay(
            row.deviceId,
            includeSensitive
          )} | ${row.createdAtUtc} |`
        );
      });
    }
  }

  if (hasDataQualityIssues) {
    markdown.push('');
    markdown.push('## Data Quality');
    markdown.push('');
    markdown.push('| Device | Status | state.status | Last Seen | Space |');
    markdown.push('| --- | --- | --- | --- | --- |');
    result.dataQuality.statusMismatches.forEach((row) =>
      markdown.push(`| ${row.device} | ${row.status} | ${row.stateStatus} | ${row.lastSeen} | ${row.space} |`)
    );
  }

  return markdown.join('\n');
}
