#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEV_REFERENCE_URL = 'https://dev.xyte.io/reference';
const ORG_REFERENCE_URL = 'https://docs.xyte.io/reference';
const SPEC_PATH = resolve(process.cwd(), 'src/spec/public-endpoints.json');

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseReferenceLinks(html) {
  const matches = html.matchAll(/href=\"(\/reference\/[^\"]+)\"/g);
  return new Set(Array.from(matches, (match) => match[1]));
}

const docSlugOverrides = {
  'device.command.getCommand': ['/reference/get-command'],
  'device.command.getCommandsWithChildren': ['/reference/get-commands-with-children'],
  'device.command.updateCommand': ['/reference/update-command'],
  'device.configuration.getConfig': ['/reference/get-config'],
  'device.configuration.setConfig': ['/reference/set-config'],
  'device.device-info.getDeviceInfo': ['/reference/get-device-info'],
  'device.device-info.getSpaceInfo': ['/reference/get-space-info'],
  'device.device-info.setCloudSettings': ['/reference/set-cloud-settings'],
  'device.device-info.spaceMove': ['/reference/space-move-api'],
  'device.device-info.updateDevice': ['/reference/update-device'],
  'device.events.addEvent': ['/reference/add-event'],
  'device.file-dumps.appendDumpFile': ['/reference/append-dump-file'],
  'device.file-dumps.sendDump': ['/reference/send-dump'],
  'device.incidents.closeIncident': ['/reference/close-incident'],
  'device.incidents.closeIncidents': ['/reference/close-incidents'],
  'device.incidents.getIncidents': ['/reference/get-incident'],
  'device.incidents.openIncident': ['/reference/create-incident'],
  'device.license.getLicense': ['/reference/get-license'],
  'device.license.updateLicense': ['/reference/update-license'],
  'device.registration.bulkRegisterDevice': ['/reference/bulk-register-devices'],
  'device.registration.deleteDevice': ['/reference/delete-device'],
  'device.registration.getChildDevices': ['/reference/get-child-devices'],
  'device.registration.registerChildDevice': ['/reference/register-child-device'],
  'device.registration.registerDevice': ['/reference/register-device'],
  'device.remote-files.getFile': ['/reference/get-file'],
  'device.remote-files.getFiles': ['/reference/get-files'],
  'device.telemetries.sendChildTelemetry': ['/reference/send-child-telemetries'],
  'device.telemetries.sendMassTelemetry': ['/reference/send-mass-telemetry'],
  'device.telemetries.sendTelemetry': ['/reference/send-telemetry'],
  'organization.commands.cancelCommand': ['/reference/cancel-command'],
  'organization.commands.getCommands': ['/reference/get-commands'],
  'organization.commands.sendCommand': ['/reference/send-command'],
  'organization.devices.claimDevice': ['/reference/claim-device'],
  'organization.devices.deleteDevice': ['/reference/delete-device'],
  'organization.devices.getDevice': ['/reference/get-device'],
  'organization.devices.getDevices': ['/reference/get-devices'],
  'organization.devices.getHistories': ['/reference/get-histories'],
  'organization.devices.updateDevice': ['/reference/update-device'],
  'organization.getOrganizationInfo': ['/reference/get-organizations-info'],
  'organization.incidents.closeIncident': ['/reference/close-incident'],
  'organization.incidents.getIncidents': ['/reference/get-incidents'],
  'organization.spaces.createSpace': ['/reference/create-space'],
  'organization.spaces.deleteSpace': ['/reference/delete-space'],
  'organization.spaces.findOrCreateSpace': ['/reference/find-or-create-space'],
  'organization.spaces.getSpace': ['/reference/get-spaces'],
  'organization.spaces.getSpaces': ['/reference/get-spaces'],
  'organization.spaces.updateSpace': ['/reference/update-space'],
  'organization.tickets.getTicket': ['/reference/get-ticket'],
  'organization.tickets.getTickets': ['/reference/get-open-tickets'],
  'organization.tickets.markResolved': ['/reference/mark-resolved'],
  'organization.tickets.sendMessage': ['/reference/send-message'],
  'organization.tickets.updateTicket': ['/reference/update-ticket'],
  'partner.devices.deleteDevice': ['/reference/partner-delete-device'],
  'partner.devices.getCommands': ['/reference/partner-get-device-commands'],
  'partner.devices.getConfiguration': ['/reference/partner-get-device-configuration'],
  'partner.devices.getDeviceInfo': ['/reference/partner-get-device-info'],
  'partner.devices.getDevices': ['/reference/partner-list-devices'],
  'partner.devices.getStateHistory': ['/reference/partner-get-device-state-history'],
  'partner.devices.getStateHistoryMultiDevices': ['/reference/partner-get-all-device-state-histories'],
  'partner.devices.getTelemetries': ['/reference/partner-get-device-telemetries'],
  'partner.tickets.addComment': ['/reference/partner-tickets-add-comment'],
  'partner.tickets.closeTicket': ['/reference/partner-tickets-close'],
  'partner.tickets.getTicket': ['/reference/partner-tickets-get'],
  'partner.tickets.getTickets': ['/reference/partner-tickets-list'],
  'partner.tickets.updateTicket': ['/reference/partner-tickets-update']
};

function candidateReferencePaths(endpointKey, endpointTitle, namespace) {
  const candidates = [];
  candidates.push(`/reference/${slugify(endpointTitle)}`);
  if (namespace === 'partner') {
    candidates.push(`/reference/partner-${slugify(endpointTitle)}`);
  }
  if (docSlugOverrides[endpointKey]) {
    candidates.push(...docSlugOverrides[endpointKey]);
  }
  return Array.from(new Set(candidates));
}

async function fetchReferenceLinks() {
  const [devHtml, orgHtml] = await Promise.all([
    fetch(DEV_REFERENCE_URL).then((response) => response.text()),
    fetch(ORG_REFERENCE_URL).then((response) => response.text())
  ]);

  return new Set([...parseReferenceLinks(devHtml), ...parseReferenceLinks(orgHtml)]);
}

function loadLocalEndpoints() {
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
}

async function main() {
  const strict = process.argv.includes('--strict');
  const links = await fetchReferenceLinks();
  const endpoints = loadLocalEndpoints();

  const missing = [];
  for (const endpoint of endpoints) {
    const candidates = candidateReferencePaths(endpoint.key, endpoint.title, endpoint.namespace);
    const matched = candidates.find((item) => links.has(item));
    if (!matched) {
      missing.push({
        key: endpoint.key,
        title: endpoint.title,
        candidates
      });
    }
  }

  const report = {
    checkedAt: new Date().toISOString(),
    docs: {
      devReferenceUrl: DEV_REFERENCE_URL,
      orgReferenceUrl: ORG_REFERENCE_URL,
      extractedLinkCount: links.size
    },
    local: {
      specPath: SPEC_PATH,
      endpointCount: endpoints.length
    },
    missingCount: missing.length,
    missing
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (strict && missing.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
