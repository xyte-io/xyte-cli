#!/usr/bin/env node
/**
 * Morning fleet report generator.
 *
 * Usage:
 *   node scripts/fleet-report.mjs [--tenant <id>] [--config-dir <path>] [--mock]
 *
 * Reads XYTE_CLI_CONFIG_DIR env var for config isolation.
 * Runs fleet inspect + deep-dive + active incidents, then prints a
 * formatted Markdown/text report to stdout.
 *
 * Exit 0 on success, 1 on any fatal error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = resolve(ROOT, 'dist/bin/xyte-cli.js');
const MOCK_SERVER = resolve(ROOT, 'scripts/mock_xyte_local.mjs');

// ── arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let tenant = undefined;
let configDir = process.env.XYTE_CLI_CONFIG_DIR;
let useMock = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tenant') { tenant = args[++i]; continue; }
  if (args[i] === '--config-dir') { configDir = args[++i]; continue; }
  if (args[i] === '--mock') { useMock = true; continue; }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function runCli(subArgs, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (configDir) childEnv.XYTE_CLI_CONFIG_DIR = configDir;
  const result = execFileSync('node', [CLI, ...subArgs], {
    encoding: 'utf8',
    env: childEnv,
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Strip warning lines (secret store warnings go to stderr, but filter
  // anything that leaked to stdout too).
  return result.replace(/^Warning:.*\n(.*\n)*?(?=\{)/gm, '').trim();
}

function tryRunCli(subArgs, env = {}) {
  try {
    return { ok: true, data: runCli(subArgs, env) };
  } catch (err) {
    const stderr = err.stderr ?? '';
    const stdout = err.stdout ?? '';
    return { ok: false, error: (stderr || stdout).trim() };
  }
}

function parseJson(raw) {
  // Find first { in the string (skip any preamble warnings on stdout)
  const start = raw.indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

function bar(filled, total, width = 20) {
  if (!total) return '░'.repeat(width);
  const n = Math.round((filled / total) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

function statusDot(status) {
  if (status === 'online' || status === 'active') return '●';
  if (status === 'offline') return '○';
  return '·';
}

function pct(n, d) {
  if (!d) return '0%';
  return `${Math.round((n / d) * 100)}%`;
}

function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : (plural ?? singular + 's')}`;
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function rpad(str, width) {
  const s = String(str);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function divider(char = '─', width = 60) {
  return char.repeat(width);
}

function formatAge(hours) {
  if (hours === undefined || hours === null) return '—';
  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

// ── mock server lifecycle ────────────────────────────────────────────────────

let mockProc = null;
let mockConfigDir = null;

async function startMock() {
  const { spawn } = await import('node:child_process');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  mockConfigDir = join(tmpdir(), `xyte-fleet-report-${process.pid}`);
  mkdirSync(mockConfigDir, { recursive: true });

  mockProc = spawn('node', [MOCK_SERVER], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
  });

  // Give the mock server time to start
  await new Promise(r => setTimeout(r, 800));

  // Configure mock tenant
  runCli(['config', 'tenant', 'add', 'mock-tenant',
    '--name', 'Mock Fleet (Demo)',
    '--hub-url', 'http://127.0.0.1:3001',
    '--entry-url', 'http://127.0.0.1:3001',
  ], { XYTE_CLI_CONFIG_DIR: mockConfigDir });

  runCli(['config', 'key', 'add',
    '--tenant', 'mock-tenant',
    '--provider', 'xyte-org',
    '--name', 'Primary',
    '--key', 'mock-org-key',
    '--set-active',
  ], { XYTE_CLI_CONFIG_DIR: mockConfigDir });

  return { tenant: 'mock-tenant', configDir: mockConfigDir };
}

function stopMock() {
  if (mockProc) {
    try { mockProc.kill(); } catch {}
    mockProc = null;
  }
}

// ── data collection ──────────────────────────────────────────────────────────

async function collect(tenantId, cfgDir) {
  const commonArgs = tenantId ? ['--tenant', tenantId] : [];
  const env = cfgDir ? { XYTE_CLI_CONFIG_DIR: cfgDir } : {};

  const [statusRes, fleetRes, deepDiveRes, incidentsRes] = [
    tryRunCli(['status', '--format', 'json'], env),
    tryRunCli(['ops', 'inspect', 'fleet', ...commonArgs, '--output', 'json'], env),
    tryRunCli(['ops', 'inspect', 'deep-dive', ...commonArgs, '--output', 'json'], env),
    tryRunCli(['ops', 'watch', 'incidents', ...commonArgs, '--once', '--output', 'json', '--strict-json'], env),
  ];

  return {
    status: statusRes.ok ? parseJson(statusRes.data) : null,
    fleet: fleetRes.ok ? parseJson(fleetRes.data) : null,
    deepDive: deepDiveRes.ok ? parseJson(deepDiveRes.data) : null,
    incidents: incidentsRes.ok ? parseJson(incidentsRes.data) : null,
    errors: {
      status: statusRes.ok ? null : statusRes.error,
      fleet: fleetRes.ok ? null : fleetRes.error,
      deepDive: deepDiveRes.ok ? null : deepDiveRes.error,
      incidents: incidentsRes.ok ? null : incidentsRes.error,
    },
  };
}

// ── report formatting ────────────────────────────────────────────────────────

function buildReport(data, tenantId, generatedAt, isMock) {
  const { status, fleet, deepDive, incidents } = data;
  const lines = [];
  const W = 64;

  function line(s = '') { lines.push(s); }
  function section(title) {
    line();
    line(divider('─', W));
    line(`  ${title.toUpperCase()}`);
    line(divider('─', W));
  }
  function kv(label, value, indent = '  ') {
    line(`${indent}${pad(label, 22)}  ${value}`);
  }

  // ── header ─────────────────────────────────────────────────────────────────
  line(divider('═', W));
  line(`  XYTE FLEET REPORT`);
  line(`  ${generatedAt}`);
  if (isMock) {
    line(`  ⚠  Demo data — no live tenant configured`);
    line(`     Run: xyte-cli setup run --tenant <id> --key-file <path>`);
  } else {
    line(`  Tenant: ${tenantId ?? 'default'}`);
  }
  line(divider('═', W));

  // ── readiness ──────────────────────────────────────────────────────────────
  if (status) {
    const r = status.readiness;
    const stateLabel = {
      ready: '✓ READY',
      needs_setup: '✗ NEEDS SETUP',
      degraded: '⚠ DEGRADED',
    }[r.state] ?? r.state.toUpperCase();

    section('Readiness');
    kv('State', stateLabel);
    if (r.missingItems?.length) {
      for (const item of r.missingItems) line(`    ! ${item}`);
    }
    if (r.recommendedActions?.length) {
      line();
      line('  Actions:');
      for (const action of r.recommendedActions) line(`    → ${action}`);
    }
  }

  // ── fleet health ───────────────────────────────────────────────────────────
  if (fleet) {
    const { totals, status: st, highlights: hi } = fleet;
    const devTotal = totals.devices ?? 0;
    const devOnline = st.devices?.online ?? 0;
    const devOffline = st.devices?.offline ?? 0;
    const devOther = devTotal - devOnline - devOffline;

    const healthPct = devTotal > 0 ? Math.round((devOnline / devTotal) * 100) : 0;
    const healthGrade =
      healthPct === 100 ? '✓ HEALTHY' :
      healthPct >= 80   ? '~ GOOD' :
      healthPct >= 50   ? '! WARNING' :
                          '✗ CRITICAL';

    section('Fleet Health');
    kv('Overall health', `${healthGrade}  (${healthPct}% online)`);
    line();
    line(`  Devices  ${bar(devOnline, devTotal)}  ${devOnline}/${devTotal}`);
    line(`    ${pad('Online', 12)} ${rpad(devOnline, 4)}  ${pct(devOnline, devTotal)}`);
    if (devOffline > 0)
    line(`    ${pad('Offline', 12)} ${rpad(devOffline, 4)}  ${pct(devOffline, devTotal)}`);
    if (devOther > 0)
    line(`    ${pad('Other', 12)} ${rpad(devOther, 4)}  ${pct(devOther, devTotal)}`);

    line();
    kv('Total devices', String(devTotal));
    kv('Spaces', String(totals.spaces ?? 0));
    kv('Active incidents', String(hi.activeIncidents ?? 0));
    kv('Open tickets', String(hi.openTickets ?? 0));
  }

  // ── active incidents ───────────────────────────────────────────────────────
  if (incidents && incidents.items) {
    const active = incidents.items;
    section(`Alerts & Incidents  (${active.length} active)`);

    if (active.length === 0) {
      line('  ✓ No active incidents.');
    } else {
      for (const inc of active) {
        line();
        line(`  [${(inc.priority ?? 'normal').toUpperCase()}]  ${inc.title ?? inc.issue ?? 'Incident'}`);
        kv('Device', inc.device_name ?? inc.device_id ?? '—', '    ');
        kv('Model', [inc.device_model, inc.device_sub_model].filter(Boolean).join(' / ') || '—', '    ');
        kv('Space', inc.space_tree_path_name ?? inc.space_name ?? '—', '    ');
        kv('Status', inc.status ?? '—', '    ');
        if (inc.description) line(`    ${inc.description}`);
      }
    }
  }

  // ── deep dive metrics ──────────────────────────────────────────────────────
  if (deepDive) {
    const { overviewMetrics: m, summary, topOfflineSpaces, topIncidentDevices,
            activeIncidentAging, ticketPosture, churnWindow } = deepDive;

    section('Key Metrics  (24h window)');
    line();
    kv('Total devices', String(m.totalDevices ?? 0));
    kv('Offline', `${m.offlineDevices ?? 0}  (${m.offlinePct ?? 0}%)`);
    kv('Active incidents', `${m.activeIncidents ?? 0}  (${m.activeIncidentPct ?? 0}%)`);
    kv('Open tickets', String(m.openTickets ?? 0));
    kv('Incident churn 24h', String(churnWindow?.incidents ?? 0));
    kv('Status mismatches', String(m.statusMismatches ?? 0));

    // Aging
    if (activeIncidentAging?.length > 0) {
      line();
      line('  Incident aging:');
      line(`    ${pad('Device', 20)}  ${pad('Space', 20)}  Age`);
      line(`    ${pad('──────', 20)}  ${pad('─────', 20)}  ───`);
      for (const entry of activeIncidentAging) {
        line(`    ${pad(entry.device ?? '—', 20)}  ${pad(entry.space ?? '—', 20)}  ${formatAge(entry.ageHours)}`);
      }
    }

    // Top offline spaces
    if (topOfflineSpaces?.length > 0) {
      line();
      line('  Top offline spaces:');
      for (const s of topOfflineSpaces.slice(0, 5)) {
        line(`    ${pad(s.space ?? '—', 24)}  ${pluralize(s.offlineDevices, 'device')} offline  (${s.shareOfOfflinePct}% of fleet offline)`);
      }
    }

    // Top incident devices
    if (topIncidentDevices?.length > 0) {
      line();
      line('  Most incident-prone devices:');
      line(`    ${pad('Device', 24)}  Total  Active`);
      line(`    ${pad('──────', 24)}  ─────  ──────`);
      for (const d of topIncidentDevices.slice(0, 5)) {
        line(`    ${pad(d.device ?? '—', 24)}  ${rpad(d.incidentCount, 5)}  ${rpad(d.activeIncidents, 6)}`);
      }
    }

    // Ticket posture
    if (ticketPosture) {
      line();
      kv('Tickets overlapping incidents', String(ticketPosture.overlappingActiveIncidentDevices ?? 0));
      if (ticketPosture.oldestOpenTickets?.length > 0) {
        const oldest = ticketPosture.oldestOpenTickets[0];
        kv('Oldest open ticket', `"${oldest.title}"  (${formatAge(oldest.ageHours)} old)`);
      }
    }

    // Summary bullets
    if (summary?.length > 0) {
      section('Summary');
      for (const bullet of summary) line(`  • ${bullet}`);
    }
  }

  // ── footer ─────────────────────────────────────────────────────────────────
  line();
  line(divider('─', W));
  if (isMock) {
    line('  Generated from demo data. Configure a live tenant to see real metrics.');
  } else {
    line(`  Generated by xyte-cli ops inspect  |  ${generatedAt}`);
  }
  line(divider('─', W));

  return lines.join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  let activeTenant = tenant;
  let activeCfgDir = configDir;
  let isMock = false;

  // Check if we need the mock server
  if (useMock) {
    const mockInfo = await startMock();
    activeTenant = mockInfo.tenant;
    activeCfgDir = mockInfo.configDir;
    isMock = true;
  } else {
    // Probe readiness — if no tenant is configured, fall back to mock
    const statusRaw = tryRunCli(['status', '--format', 'json'], configDir ? { XYTE_CLI_CONFIG_DIR: configDir } : {});
    const statusData = statusRaw.ok ? parseJson(statusRaw.data) : null;
    if (!statusData || statusData.readiness?.state === 'needs_setup') {
      process.stderr.write('No live tenant configured — using mock data for demo report.\n');
      const mockInfo = await startMock();
      activeTenant = mockInfo.tenant;
      activeCfgDir = mockInfo.configDir;
      isMock = true;
    }
  }

  try {
    const data = await collect(activeTenant, activeCfgDir);
    const report = buildReport(data, activeTenant, now, isMock);
    process.stdout.write(report + '\n');
  } finally {
    stopMock();
    // Clean up temp config dir for mock runs
    if (isMock && mockConfigDir) {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(mockConfigDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

main().catch(err => {
  process.stderr.write(`fleet-report: fatal: ${err.message}\n`);
  process.exit(1);
});
