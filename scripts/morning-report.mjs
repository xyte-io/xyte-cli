#!/usr/bin/env node
/**
 * Xyte Fleet Morning Report
 *
 * Fetches fleet status via xyte-cli, formats a polished HTML report, and delivers
 * it via email (SMTP) or Slack webhook.
 *
 * Required env:
 *   XYTE_TENANT_ID  (or defaults.tenant in xyte-cli config)
 *
 * Optional delivery env:
 *   XYTE_REPORT_TO              Recipient email (default: CLAUDE_CODE_USER_EMAIL)
 *   XYTE_REPORT_FROM            Sender address (default: reports@xyte.local)
 *   XYTE_REPORT_SMTP_HOST       SMTP host
 *   XYTE_REPORT_SMTP_PORT       SMTP port (default: 587)
 *   XYTE_REPORT_SMTP_USER       SMTP username
 *   XYTE_REPORT_SMTP_PASS       SMTP password
 *   XYTE_REPORT_SLACK_WEBHOOK   Slack incoming webhook URL
 *   XYTE_REPORT_OUT_DIR         Directory to save HTML report (default: ~/.xyte-cli/reports)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Config ────────────────────────────────────────────────────────────────────

const CLI = new URL('../dist/bin/xyte-cli.js', import.meta.url).pathname;
const TENANT = process.env.XYTE_TENANT_ID;
const TO = process.env.XYTE_REPORT_TO || process.env.CLAUDE_CODE_USER_EMAIL || '';
const FROM = process.env.XYTE_REPORT_FROM || 'reports@xyte.local';
const SMTP_HOST = process.env.XYTE_REPORT_SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.XYTE_REPORT_SMTP_PORT || '587', 10);
const SMTP_USER = process.env.XYTE_REPORT_SMTP_USER || '';
const SMTP_PASS = process.env.XYTE_REPORT_SMTP_PASS || '';
const SLACK_WEBHOOK = process.env.XYTE_REPORT_SLACK_WEBHOOK || '';
const OUT_DIR = process.env.XYTE_REPORT_OUT_DIR || join(homedir(), '.xyte-cli', 'reports');

// ── CLI helpers ───────────────────────────────────────────────────────────────

function runCli(args) {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env }
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `xyte-cli exited ${result.status}`);
  }
  return result.stdout.trim();
}

function fetchFleet(tenant) {
  const args = ['ops', 'inspect', 'fleet', '--render', 'json', '--strict-json'];
  if (tenant) args.push('--tenant', tenant);
  return JSON.parse(runCli(args));
}

function fetchDeepDive(tenant) {
  const args = ['ops', 'inspect', 'deep-dive', '--render', 'json', '--strict-json', '--window', '24'];
  if (tenant) args.push('--tenant', tenant);
  return JSON.parse(runCli(args));
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function pct(n) {
  return `${Number(n).toFixed(1)}%`;
}

function statusBadge(ok) {
  return ok
    ? `<span style="background:#16a34a;color:#fff;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.5px">HEALTHY</span>`
    : `<span style="background:#dc2626;color:#fff;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.5px">ALERT</span>`;
}

function kpi(label, value, sub, accent) {
  const border = accent ? `border-top:3px solid ${accent}` : 'border-top:3px solid #6366f1';
  return `
    <td style="padding:0 8px 0 0;width:25%">
      <div style="background:#fff;border-radius:10px;${border};padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">${label}</div>
        <div style="font-size:28px;font-weight:700;color:#111827;line-height:1">${value}</div>
        ${sub ? `<div style="font-size:12px;color:#9ca3af;margin-top:4px">${sub}</div>` : ''}
      </div>
    </td>`.trim();
}

function tableRow(cells, isHeader) {
  const tag = isHeader ? 'th' : 'td';
  const style = isHeader
    ? 'background:#f9fafb;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;padding:10px 16px;text-align:left;font-weight:600'
    : 'padding:10px 16px;font-size:13px;color:#374151;border-top:1px solid #f3f4f6';
  return `<tr>${cells.map((c) => `<${tag} style="${style}">${c}</${tag}>`).join('')}</tr>`;
}

function section(title, content, accent = '#6366f1') {
  return `
    <div style="margin-bottom:24px">
      <div style="font-size:13px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:.7px;margin-bottom:10px;display:flex;align-items:center;gap:8px">
        <span style="display:inline-block;width:3px;height:16px;background:${accent};border-radius:2px"></span>
        ${title}
      </div>
      ${content}
    </div>`.trim();
}

// ── HTML report builder ───────────────────────────────────────────────────────

function buildHtml(fleet, dive, dateStr) {
  const m = fleet.overviewMetrics || {
    totalDevices: fleet.totals?.devices ?? 0,
    offlineDevices: fleet.highlights?.offlineDevices ?? 0,
    offlinePct: fleet.highlights?.offlinePct ?? 0,
    totalIncidents: fleet.totals?.incidents ?? 0,
    activeIncidents: fleet.highlights?.activeIncidents ?? 0,
    activeIncidentPct: fleet.highlights?.activeIncidentPct ?? 0,
    totalTickets: fleet.totals?.tickets ?? 0,
    openTickets: fleet.highlights?.openTickets ?? 0,
    statusMismatches: 0
  };

  const overviewMetrics = dive.overviewMetrics || m;
  const isHealthy = overviewMetrics.activeIncidents === 0 && overviewMetrics.offlinePct < 5;

  // KPI row
  const kpiRow = `
    <table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;margin-bottom:24px">
      <tr>
        ${kpi('Total Devices', overviewMetrics.totalDevices, `${overviewMetrics.offlineDevices} offline`, '#6366f1')}
        ${kpi('Online Rate', pct(100 - overviewMetrics.offlinePct), `${pct(overviewMetrics.offlinePct)} offline`, overviewMetrics.offlinePct > 10 ? '#dc2626' : '#16a34a')}
        ${kpi('Active Incidents', overviewMetrics.activeIncidents, `of ${overviewMetrics.totalIncidents} total`, overviewMetrics.activeIncidents > 0 ? '#f59e0b' : '#16a34a')}
        ${kpi('Open Tickets', overviewMetrics.openTickets, `of ${overviewMetrics.totalTickets} total`, overviewMetrics.openTickets > 0 ? '#f59e0b' : '#16a34a')}
      </tr>
    </table>`.trim();

  // Summary bullets
  const summaryHtml = dive.summary?.length
    ? `<ul style="margin:0;padding-left:20px">${dive.summary.map((l) => `<li style="font-size:13px;color:#374151;margin-bottom:4px">${l}</li>`).join('')}</ul>`
    : `<p style="font-size:13px;color:#374151;margin:0">No summary available.</p>`;

  // Top offline spaces table
  let offlineSpacesHtml = '';
  if (dive.topOfflineSpaces?.length) {
    const rows = dive.topOfflineSpaces
      .map((r) => tableRow([r.space, r.offlineDevices, `${r.shareOfOfflinePct}%`]))
      .join('');
    offlineSpacesHtml = section(
      'Top Offline Spaces',
      `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        ${tableRow(['Space', 'Offline Devices', 'Share of Offline'], true)}
        ${rows}
      </table>`,
      '#ef4444'
    );
  }

  // Active incident aging table
  let agingHtml = '';
  if (dive.activeIncidentAging?.length) {
    const rows = dive.activeIncidentAging
      .map((r) => tableRow([r.device, r.space, `${r.ageHours}h`, r.createdAtUtc]))
      .join('');
    agingHtml = section(
      'Active Incident Aging',
      `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        ${tableRow(['Device', 'Space', 'Age', 'Created'], true)}
        ${rows}
      </table>`,
      '#f59e0b'
    );
  }

  // Open tickets table
  let ticketsHtml = '';
  if (dive.ticketPosture?.oldestOpenTickets?.length) {
    const rows = dive.ticketPosture.oldestOpenTickets
      .map((t) => tableRow([t.title, `${t.ageHours}h`, t.ticketId]))
      .join('');
    ticketsHtml = section(
      `Open Tickets (${dive.ticketPosture.openTickets})`,
      `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        ${tableRow(['Title', 'Age', 'ID'], true)}
        ${rows}
      </table>`,
      '#8b5cf6'
    );
  }

  // 24h churn window
  let churnHtml = '';
  if (dive.churnWindow?.incidents > 0) {
    const bySpace = dive.churnWindow.bySpace?.length
      ? `<div style="margin-top:8px"><strong>By space:</strong> ${dive.churnWindow.bySpace.map((r) => `${r.space} (${r.incidents})`).join(', ')}</div>`
      : '';
    churnHtml = section(
      `24h Churn Window`,
      `<div style="background:#fff;border-radius:10px;padding:16px 20px;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:13px;color:#374151">
        <strong>${dive.churnWindow.incidents}</strong> incidents across <strong>${dive.churnWindow.devices}</strong> devices in <strong>${dive.churnWindow.spaces}</strong> spaces.
        ${bySpace}
      </div>`,
      '#0ea5e9'
    );
  }

  // Healthy message
  const healthBanner = isHealthy
    ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:24px;font-size:13px;color:#166534">
         ✅ <strong>All systems healthy.</strong> No active incidents, offline rate below 5%.
       </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xyte Fleet Report — ${dateStr}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0">
  <tr><td align="center">
    <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">

      <!-- Header -->
      <tr><td style="background:#1e1b4b;border-radius:12px 12px 0 0;padding:28px 32px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td>
            <div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-.3px">Xyte Fleet Report</div>
            <div style="font-size:13px;color:#a5b4fc;margin-top:2px">${dateStr} · Tenant ${fleet.tenantId || dive.tenantId || 'unknown'}</div>
          </td>
          <td align="right">${statusBadge(isHealthy)}</td>
        </tr></table>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#f3f4f6;padding:24px 0 0">

        <!-- KPIs -->
        ${kpiRow}

        <!-- Summary -->
        ${section('24h Summary', `<div style="background:#fff;border-radius:10px;padding:16px 20px;box-shadow:0 1px 4px rgba(0,0,0,.08)">${summaryHtml}</div>`)}

        ${healthBanner}
        ${offlineSpacesHtml}
        ${agingHtml}
        ${churnHtml}
        ${ticketsHtml}

        <!-- Footer -->
        <div style="font-size:11px;color:#9ca3af;text-align:center;padding:16px 0 8px">
          Generated by xyte-cli · ${dateStr} UTC
        </div>

      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return html;
}

// ── Delivery ──────────────────────────────────────────────────────────────────

function deliverEmail(subject, html, textFallback) {
  if (!SMTP_HOST) throw new Error('XYTE_REPORT_SMTP_HOST not set');

  const pythonScript = `
import smtplib, ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

msg = MIMEMultipart('alternative')
msg['Subject'] = ${JSON.stringify(subject)}
msg['From'] = ${JSON.stringify(FROM)}
msg['To'] = ${JSON.stringify(TO)}
msg.attach(MIMEText(${JSON.stringify(textFallback)}, 'plain'))
msg.attach(MIMEText(${JSON.stringify(html)}, 'html'))

context = ssl.create_default_context()
with smtplib.SMTP(${JSON.stringify(SMTP_HOST)}, ${SMTP_PORT}) as s:
    s.ehlo()
    s.starttls(context=context)
    ${SMTP_USER ? `s.login(${JSON.stringify(SMTP_USER)}, ${JSON.stringify(SMTP_PASS)})` : '# no auth'}
    s.sendmail(${JSON.stringify(FROM)}, [${JSON.stringify(TO)}], msg.as_string())
print('email sent')
`;

  const result = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'email send failed');
  return result.stdout.trim();
}

function deliverSlack(subject, fleet, dive) {
  const m = dive.overviewMetrics || {};
  const isHealthy = (m.activeIncidents ?? 0) === 0 && (m.offlinePct ?? 0) < 5;
  const icon = isHealthy ? ':white_check_mark:' : ':warning:';
  const summary = (dive.summary || []).slice(0, 3).join('\n• ');

  const payload = JSON.stringify({
    text: `${icon} *${subject}*`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${icon} Xyte Fleet Report`, emoji: true }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Devices*\n${m.totalDevices ?? '—'} (${Number(m.offlinePct ?? 0).toFixed(1)}% offline)` },
          { type: 'mrkdwn', text: `*Active Incidents*\n${m.activeIncidents ?? '—'}` },
          { type: 'mrkdwn', text: `*Open Tickets*\n${m.openTickets ?? '—'}` },
          { type: 'mrkdwn', text: `*Online Rate*\n${(100 - (m.offlinePct ?? 0)).toFixed(1)}%` }
        ]
      },
      ...(summary
        ? [{ type: 'section', text: { type: 'mrkdwn', text: `*24h Summary*\n• ${summary}` } }]
        : []),
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Generated by xyte-cli · ${new Date().toUTCString()}` }]
      }
    ]
  });

  const result = spawnSync(
    'curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', payload, SLACK_WEBHOOK],
    { encoding: 'utf8', timeout: 10_000 }
  );
  const code = (result.stdout || '').trim();
  if (code !== '200') throw new Error(`Slack returned HTTP ${code}`);
}

function saveReport(html, dateStr) {
  mkdirSync(OUT_DIR, { recursive: true });
  const filename = `fleet-report-${dateStr.replace(/[: ]/g, '-')}.html`;
  const outPath = join(OUT_DIR, filename);
  writeFileSync(outPath, html, 'utf8');
  return outPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);
  console.log(`[morning-report] ${new Date().toISOString()} — fetching fleet data…`);

  let fleet, dive;
  try {
    fleet = fetchFleet(TENANT);
    dive = fetchDeepDive(TENANT);
  } catch (err) {
    console.error(`[morning-report] ERROR fetching fleet data: ${err.message}`);
    process.exit(1);
  }

  const html = buildHtml(fleet, dive, dateStr);
  const subject = `Xyte Fleet Report — ${dateStr}`;
  const textFallback = dive.summary?.join('\n') || 'Fleet report ready.';

  // Save HTML report regardless of delivery method
  const savedPath = saveReport(html, dateStr);
  console.log(`[morning-report] Report saved to ${savedPath}`);

  let delivered = false;

  if (SLACK_WEBHOOK) {
    try {
      deliverSlack(subject, fleet, dive);
      console.log('[morning-report] Delivered via Slack');
      delivered = true;
    } catch (err) {
      console.error(`[morning-report] Slack delivery failed: ${err.message}`);
    }
  }

  if (!delivered && SMTP_HOST && TO) {
    try {
      deliverEmail(subject, html, textFallback);
      console.log(`[morning-report] Delivered via email to ${TO}`);
      delivered = true;
    } catch (err) {
      console.error(`[morning-report] Email delivery failed: ${err.message}`);
    }
  }

  if (!delivered) {
    console.log(`[morning-report] No delivery method configured. Report at: ${savedPath}`);
    console.log('[morning-report] Set XYTE_REPORT_SMTP_HOST/XYTE_REPORT_SLACK_WEBHOOK to enable delivery.');
  }
}

main().catch((err) => {
  console.error(`[morning-report] Fatal: ${err.message}`);
  process.exit(1);
});
