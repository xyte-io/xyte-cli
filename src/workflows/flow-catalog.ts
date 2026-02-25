export type BuiltInFlowId =
  | 'flow.setup-readiness-10m'
  | 'flow.incidents-delta-watch'
  | 'flow.watch-to-triage'
  | 'flow.guided-remediation'
  | 'flow.bulk-claim-and-space-import'
  | 'flow.daily-deep-dive-report';

export type FlowTaskType =
  | 'doctor.install'
  | 'setup.status'
  | 'config.doctor'
  | 'status.fast'
  | 'inspect.fleet'
  | 'watch'
  | 'inspect.deep-dive'
  | 'report.generate'
  | 'call'
  | 'utility.prepare'
  | 'space.import-tree';

export interface FlowStepBase {
  id: string;
  title: string;
  command: string;
}

export interface FlowTaskStep extends FlowStepBase {
  kind: 'task';
  task: FlowTaskType;
  mutating: boolean;
  requiresContext?: string[];
  watch?: {
    profile: 'incidents-active';
    once: boolean;
    intervalMs?: number;
    maxPolls?: number;
  };
  inspect?: {
    mode: 'fleet' | 'deep-dive';
    windowHours?: number;
  };
  report?: {
    format: 'markdown' | 'pdf';
    inputFromStepId: string;
    outFileName: string;
    includeSensitive?: boolean;
  };
  call?: {
    endpointKey: string;
    path?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: unknown;
    outputMode?: 'raw' | 'envelope';
    confirm?: string;
  };
  utilityPrepare?: {
    actionKey: string;
    inputPath: string;
    outputDir: string;
    primaryFormat?: 'csv' | 'jsonl';
  };
  spaceImportTree?: {
    inputPath: string;
    apply: boolean;
    reportPath: string;
  };
}

export interface FlowGateStep extends FlowStepBase {
  kind: 'gate';
  mutating: boolean;
  detail: string;
}

export type FlowStep = FlowTaskStep | FlowGateStep;

export interface BuiltInFlowDefinition {
  id: BuiltInFlowId;
  title: string;
  intent: string;
  writeCapable: boolean;
  recipeCommands: string[];
  steps: FlowStep[];
}

const FLOWS: Record<BuiltInFlowId, BuiltInFlowDefinition> = {
  'flow.setup-readiness-10m': {
    id: 'flow.setup-readiness-10m',
    title: 'Setup Readiness 10m',
    intent: 'Verify install, readiness, connectivity, and baseline fleet visibility.',
    writeCapable: false,
    recipeCommands: [
      'xyte-cli doctor install --format json',
      'xyte-cli setup status --tenant <tenant-id> --format json',
      'xyte-cli config doctor --tenant <tenant-id> --format json',
      'xyte-cli status --tenant <tenant-id> --mode fast --format json',
      'xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.setup.json'
    ],
    steps: [
      {
        kind: 'task',
        id: 'doctor_install',
        title: 'Doctor Install',
        task: 'doctor.install',
        mutating: false,
        command: 'xyte-cli doctor install --format json'
      },
      {
        kind: 'task',
        id: 'setup_status',
        title: 'Setup Status',
        task: 'setup.status',
        mutating: false,
        command: 'xyte-cli setup status --tenant <tenant-id> --format json'
      },
      {
        kind: 'task',
        id: 'config_doctor',
        title: 'Config Doctor',
        task: 'config.doctor',
        mutating: false,
        command: 'xyte-cli config doctor --tenant <tenant-id> --format json'
      },
      {
        kind: 'task',
        id: 'status_fast',
        title: 'Status Fast',
        task: 'status.fast',
        mutating: false,
        command: 'xyte-cli status --tenant <tenant-id> --mode fast --format json'
      },
      {
        kind: 'task',
        id: 'inspect_fleet_setup',
        title: 'Inspect Fleet Setup',
        task: 'inspect.fleet',
        inspect: { mode: 'fleet' },
        mutating: false,
        command: 'xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.setup.json'
      }
    ]
  },
  'flow.incidents-delta-watch': {
    id: 'flow.incidents-delta-watch',
    title: 'Incidents Delta Watch',
    intent: 'Stream deterministic incident snapshots and deltas.',
    writeCapable: false,
    recipeCommands: [
      'xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json',
      'xyte-cli watch --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --strict-json > /tmp/xyte-watch.incidents.ndjson'
    ],
    steps: [
      {
        kind: 'task',
        id: 'watch_once',
        title: 'Watch Once',
        task: 'watch',
        watch: {
          profile: 'incidents-active',
          once: true
        },
        mutating: false,
        command: 'xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json'
      },
      {
        kind: 'task',
        id: 'watch_loop',
        title: 'Watch Loop',
        task: 'watch',
        watch: {
          profile: 'incidents-active',
          once: false,
          intervalMs: 2000,
          maxPolls: 30
        },
        mutating: false,
        command: 'xyte-cli watch --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --strict-json > /tmp/xyte-watch.incidents.ndjson'
      }
    ]
  },
  'flow.watch-to-triage': {
    id: 'flow.watch-to-triage',
    title: 'Watch To Triage',
    intent: 'Pivot from watch deltas into deterministic triage artifacts.',
    writeCapable: false,
    recipeCommands: [
      'xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.triage.ndjson',
      'xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.triage.json',
      'xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.triage.json',
      'xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.triage.json --out /tmp/xyte-triage.md --format markdown'
    ],
    steps: [
      {
        kind: 'task',
        id: 'watch_once_triage',
        title: 'Watch Once Triage',
        task: 'watch',
        watch: {
          profile: 'incidents-active',
          once: true
        },
        mutating: false,
        command: 'xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.triage.ndjson'
      },
      {
        kind: 'task',
        id: 'inspect_fleet_triage',
        title: 'Inspect Fleet Triage',
        task: 'inspect.fleet',
        inspect: { mode: 'fleet' },
        mutating: false,
        command: 'xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.triage.json'
      },
      {
        kind: 'task',
        id: 'inspect_deep_dive_triage',
        title: 'Inspect Deep Dive Triage',
        task: 'inspect.deep-dive',
        inspect: {
          mode: 'deep-dive',
          windowHours: 24
        },
        mutating: false,
        command: 'xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.triage.json'
      },
      {
        kind: 'task',
        id: 'report_triage',
        title: 'Generate Triage Report',
        task: 'report.generate',
        report: {
          inputFromStepId: 'inspect_deep_dive_triage',
          outFileName: 'xyte-triage.md',
          format: 'markdown'
        },
        mutating: false,
        command: 'xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.triage.json --out /tmp/xyte-triage.md --format markdown'
      },
      {
        kind: 'gate',
        id: 'decision_monitor_or_remediate',
        title: 'Human Decision Gate',
        mutating: false,
        detail: 'Choose read-only monitoring or switch to flow.guided-remediation.',
        command: 'Human decision gate: monitor or remediate'
      }
    ]
  },
  'flow.guided-remediation': {
    id: 'flow.guided-remediation',
    title: 'Guided Remediation',
    intent: 'Run controlled org-scope remediation writes with explicit gates.',
    writeCapable: true,
    recipeCommands: [
      'xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.before.ndjson',
      'xyte-cli call organization.commands.getCommands \\',
      '--tenant <tenant-id> \\',
      '--path-json {"device_id":"<device-id>"} \\',
      '--query-json {"page":1,"per_page":20}',
      'xyte-cli call organization.commands.sendCommand \\',
      '--tenant <tenant-id> \\',
      '--allow-write \\',
      '--path-json {"device_id":"<device-id>"} \\',
      '--body-json {"command":"<valid-command-from-history>"}',
      'xyte-cli call organization.devices.updateDevice \\',
      '--tenant <tenant-id> \\',
      '--allow-write \\',
      '--path-json {"device_id":"<device-id>"} \\',
      '--body-json {"name":"<updated-device-name>"}',
      'xyte-cli call organization.devices.getDevice \\',
      '--tenant <tenant-id> \\',
      '--path-json {"device_id":"<device-id>"}',
      'xyte-cli call organization.tickets.sendMessage \\',
      '--tenant <tenant-id> \\',
      '--allow-write \\',
      '--path-json {"ticket_id":"<ticket-id>"} \\',
      '--query-json {"message":"Operator approved remediation for incident <incident-id> on device <device-id>."}',
      'xyte-cli call organization.incidents.closeIncident \\',
      '--tenant <tenant-id> \\',
      '--allow-write \\',
      '--confirm organization.incidents.closeIncident \\',
      '--path-json {"incident_id":"<incident-id>"}',
      'xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.after.ndjson'
    ],
    steps: [
      {
        kind: 'task',
        id: 'watch_before',
        title: 'Watch Before',
        task: 'watch',
        watch: {
          profile: 'incidents-active',
          once: true
        },
        mutating: false,
        command: 'xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.before.ndjson'
      },
      {
        kind: 'task',
        id: 'commands_get',
        title: 'Get Commands',
        task: 'call',
        call: {
          endpointKey: 'organization.commands.getCommands',
          path: {
            device_id: '{{device_id}}'
          },
          query: {
            page: 1,
            per_page: 20
          },
          outputMode: 'envelope'
        },
        requiresContext: ['device_id'],
        mutating: false,
        command: 'xyte-cli call organization.commands.getCommands --tenant <tenant-id> --path-json {"device_id":"<device-id>"} --query-json {"page":1,"per_page":20}'
      },
      {
        kind: 'gate',
        id: 'gate_send_command',
        title: 'Approve Send Command',
        mutating: true,
        detail: 'Human approval required before organization.commands.sendCommand.',
        command: 'Human decision gate before sendCommand'
      },
      {
        kind: 'task',
        id: 'commands_send',
        title: 'Send Command',
        task: 'call',
        call: {
          endpointKey: 'organization.commands.sendCommand',
          path: {
            device_id: '{{device_id}}'
          },
          body: {
            command: '{{command}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['device_id', 'command'],
        mutating: true,
        command: 'xyte-cli call organization.commands.sendCommand --tenant <tenant-id> --allow-write --path-json {"device_id":"<device-id>"} --body-json {"command":"<valid-command-from-history>"}'
      },
      {
        kind: 'gate',
        id: 'gate_update_device',
        title: 'Approve Update Device',
        mutating: true,
        detail: 'Human approval required before organization.devices.updateDevice.',
        command: 'Human decision gate before updateDevice'
      },
      {
        kind: 'task',
        id: 'device_update',
        title: 'Update Device',
        task: 'call',
        call: {
          endpointKey: 'organization.devices.updateDevice',
          path: {
            device_id: '{{device_id}}'
          },
          body: {
            name: '{{updated_device_name}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['device_id', 'updated_device_name'],
        mutating: true,
        command: 'xyte-cli call organization.devices.updateDevice --tenant <tenant-id> --allow-write --path-json {"device_id":"<device-id>"} --body-json {"name":"<updated-device-name>"}'
      },
      {
        kind: 'task',
        id: 'device_get_verify',
        title: 'Get Device Verify',
        task: 'call',
        call: {
          endpointKey: 'organization.devices.getDevice',
          path: {
            device_id: '{{device_id}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['device_id'],
        mutating: false,
        command: 'xyte-cli call organization.devices.getDevice --tenant <tenant-id> --path-json {"device_id":"<device-id>"}'
      },
      {
        kind: 'gate',
        id: 'gate_ticket_message',
        title: 'Approve Ticket Message',
        mutating: true,
        detail: 'Human approval required before organization.tickets.sendMessage.',
        command: 'Human decision gate before ticket sendMessage'
      },
      {
        kind: 'task',
        id: 'ticket_send_message',
        title: 'Send Ticket Message',
        task: 'call',
        call: {
          endpointKey: 'organization.tickets.sendMessage',
          path: {
            ticket_id: '{{ticket_id}}'
          },
          query: {
            message: 'Operator approved remediation for incident {{incident_id}} on device {{device_id}}.'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['ticket_id', 'incident_id', 'device_id'],
        mutating: true,
        command: 'xyte-cli call organization.tickets.sendMessage --tenant <tenant-id> --allow-write --path-json {"ticket_id":"<ticket-id>"} --query-json {"message":"Operator approved remediation for incident <incident-id> on device <device-id>."}'
      },
      {
        kind: 'gate',
        id: 'gate_close_incident',
        title: 'Approve Close Incident',
        mutating: true,
        detail: 'Human approval required before organization.incidents.closeIncident.',
        command: 'Human decision gate before closeIncident'
      },
      {
        kind: 'task',
        id: 'incident_close',
        title: 'Close Incident',
        task: 'call',
        call: {
          endpointKey: 'organization.incidents.closeIncident',
          path: {
            incident_id: '{{incident_id}}'
          },
          confirm: 'organization.incidents.closeIncident',
          outputMode: 'envelope'
        },
        requiresContext: ['incident_id'],
        mutating: true,
        command: 'xyte-cli call organization.incidents.closeIncident --tenant <tenant-id> --allow-write --confirm organization.incidents.closeIncident --path-json {"incident_id":"<incident-id>"}'
      },
      {
        kind: 'task',
        id: 'watch_after',
        title: 'Watch After',
        task: 'watch',
        watch: {
          profile: 'incidents-active',
          once: true
        },
        mutating: false,
        command: 'xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.after.ndjson'
      }
    ]
  },
  'flow.bulk-claim-and-space-import': {
    id: 'flow.bulk-claim-and-space-import',
    title: 'Bulk Claim And Space Import',
    intent: 'Preprocess claim/import inputs, dry-run safely, then apply guarded writes.',
    writeCapable: true,
    recipeCommands: [
      'xyte-cli utility prepare \\',
      '--action organization.devices.claimDevice \\',
      '--tenant <tenant-id> \\',
      '--input ./claims-source.csv \\',
      '--output-dir ./tmp/flow-bulk-claim',
      'xyte-cli call organization.spaces.getSpace \\',
      '--tenant <tenant-id> \\',
      '--path-json {"space_id":"<space-id>"}',
      'xyte-cli utility prepare \\',
      '--action space.import-tree \\',
      '--tenant <tenant-id> \\',
      '--input ./spaces-source.csv \\',
      '--output-dir ./tmp/flow-space-import',
      'xyte-cli space import-tree \\',
      '--tenant <tenant-id> \\',
      '--input ./tmp/flow-space-import/space-import-tree.csv \\',
      '--report ./tmp/flow-space-import/space-import-tree.dryrun.ndjson',
      'xyte-cli call organization.devices.claimDevice \\',
      '--tenant <tenant-id> \\',
      '--allow-write \\',
      '--output-mode envelope \\',
      '--body-json {"name":"<device-name>","space_id":"<space-id>","sn":"<serial>","mac":"<mac>","cloud_id":"<cloud-id>"}',
      'xyte-cli space import-tree \\',
      '--tenant <tenant-id> \\',
      '--input ./tmp/flow-space-import/space-import-tree.csv \\',
      '--apply \\',
      '--report ./tmp/flow-space-import/space-import-tree.apply.ndjson'
    ],
    steps: [
      {
        kind: 'task',
        id: 'prepare_claim',
        title: 'Prepare Claim Input',
        task: 'utility.prepare',
        utilityPrepare: {
          actionKey: 'organization.devices.claimDevice',
          inputPath: './claims-source.csv',
          outputDir: './tmp/flow-bulk-claim'
        },
        mutating: false,
        command: 'xyte-cli utility prepare --action organization.devices.claimDevice --tenant <tenant-id> --input ./claims-source.csv --output-dir ./tmp/flow-bulk-claim'
      },
      {
        kind: 'task',
        id: 'get_space',
        title: 'Get Space',
        task: 'call',
        call: {
          endpointKey: 'organization.spaces.getSpace',
          path: {
            space_id: '{{space_id}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['space_id'],
        mutating: false,
        command: 'xyte-cli call organization.spaces.getSpace --tenant <tenant-id> --path-json {"space_id":"<space-id>"}'
      },
      {
        kind: 'task',
        id: 'prepare_space_import',
        title: 'Prepare Space Import Input',
        task: 'utility.prepare',
        utilityPrepare: {
          actionKey: 'space.import-tree',
          inputPath: './spaces-source.csv',
          outputDir: './tmp/flow-space-import'
        },
        mutating: false,
        command: 'xyte-cli utility prepare --action space.import-tree --tenant <tenant-id> --input ./spaces-source.csv --output-dir ./tmp/flow-space-import'
      },
      {
        kind: 'task',
        id: 'space_import_dryrun',
        title: 'Space Import Dry Run',
        task: 'space.import-tree',
        spaceImportTree: {
          inputPath: '{{space_import_tree_csv}}',
          apply: false,
          reportPath: './tmp/flow-space-import/space-import-tree.dryrun.ndjson'
        },
        mutating: false,
        command: 'xyte-cli space import-tree --tenant <tenant-id> --input ./tmp/flow-space-import/space-import-tree.csv --report ./tmp/flow-space-import/space-import-tree.dryrun.ndjson'
      },
      {
        kind: 'gate',
        id: 'gate_claim_apply',
        title: 'Approve Claim Loop',
        mutating: true,
        detail: 'Human approval required after preprocessing and before claim/apply loops.',
        command: 'Human decision gate before claim loop'
      },
      {
        kind: 'task',
        id: 'claim_device',
        title: 'Claim Device',
        task: 'call',
        call: {
          endpointKey: 'organization.devices.claimDevice',
          body: {
            name: '{{claim_name}}',
            space_id: '{{space_id}}',
            sn: '{{sn}}',
            mac: '{{mac}}',
            cloud_id: '{{cloud_id}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['claim_name', 'space_id', 'sn', 'mac', 'cloud_id'],
        mutating: true,
        command: 'xyte-cli call organization.devices.claimDevice --tenant <tenant-id> --allow-write --output-mode envelope --body-json {"name":"<device-name>","space_id":"<space-id>","sn":"<serial>","mac":"<mac>","cloud_id":"<cloud-id>"}'
      },
      {
        kind: 'gate',
        id: 'gate_space_apply',
        title: 'Approve Space Apply',
        mutating: true,
        detail: 'Human approval required before space import apply.',
        command: 'Human decision gate before space import apply'
      },
      {
        kind: 'task',
        id: 'space_import_apply',
        title: 'Space Import Apply',
        task: 'space.import-tree',
        spaceImportTree: {
          inputPath: '{{space_import_tree_csv}}',
          apply: true,
          reportPath: './tmp/flow-space-import/space-import-tree.apply.ndjson'
        },
        mutating: true,
        command: 'xyte-cli space import-tree --tenant <tenant-id> --input ./tmp/flow-space-import/space-import-tree.csv --apply --report ./tmp/flow-space-import/space-import-tree.apply.ndjson'
      }
    ]
  },
  'flow.daily-deep-dive-report': {
    id: 'flow.daily-deep-dive-report',
    title: 'Daily Deep Dive Report',
    intent: 'Produce daily deep-dive JSON and markdown report artifacts.',
    writeCapable: false,
    recipeCommands: [
      'xyte-cli setup status --tenant <tenant-id> --format json',
      'xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.daily.json',
      'xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.daily.json --out /tmp/xyte-daily.md --format markdown',
      'xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.daily.json'
    ],
    steps: [
      {
        kind: 'task',
        id: 'setup_status_daily',
        title: 'Setup Status',
        task: 'setup.status',
        mutating: false,
        command: 'xyte-cli setup status --tenant <tenant-id> --format json'
      },
      {
        kind: 'task',
        id: 'inspect_deep_dive_daily',
        title: 'Inspect Deep Dive Daily',
        task: 'inspect.deep-dive',
        inspect: {
          mode: 'deep-dive',
          windowHours: 24
        },
        mutating: false,
        command: 'xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.daily.json'
      },
      {
        kind: 'task',
        id: 'report_daily',
        title: 'Generate Daily Report',
        task: 'report.generate',
        report: {
          inputFromStepId: 'inspect_deep_dive_daily',
          outFileName: 'xyte-daily.md',
          format: 'markdown'
        },
        mutating: false,
        command: 'xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.daily.json --out /tmp/xyte-daily.md --format markdown'
      },
      {
        kind: 'task',
        id: 'inspect_fleet_daily',
        title: 'Inspect Fleet Daily',
        task: 'inspect.fleet',
        inspect: {
          mode: 'fleet'
        },
        mutating: false,
        command: 'xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.daily.json'
      },
      {
        kind: 'gate',
        id: 'decision_distribute_or_escalate',
        title: 'Human Decision Gate',
        mutating: false,
        detail: 'Approve report distribution or escalate to flow.watch-to-triage.',
        command: 'Human decision gate: distribute report or escalate'
      }
    ]
  }
};

export function listBuiltInFlowDefinitions(): BuiltInFlowDefinition[] {
  return Object.values(FLOWS).sort((left, right) => left.id.localeCompare(right.id));
}

export function getBuiltInFlowDefinition(flowId: string): BuiltInFlowDefinition {
  const maybe = FLOWS[flowId as BuiltInFlowId];
  if (!maybe) {
    throw new Error(`Unknown flow id: ${flowId}`);
  }
  return maybe;
}

export function hasBuiltInFlowDefinition(flowId: string): flowId is BuiltInFlowId {
  return Boolean(FLOWS[flowId as BuiltInFlowId]);
}
