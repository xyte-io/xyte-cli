export type BuiltInFlowId =
  | 'flow.setup-readiness-10m'
  | 'flow.incidents-delta-watch'
  | 'flow.watch-to-triage'
  | 'flow.guided-remediation'
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

interface FlowStepBase {
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
      'xyte-cli setup status --tenant <tenant-id> --output json',
      'xyte-cli config doctor --tenant <tenant-id> --output json',
      'xyte-cli status --tenant <tenant-id> --mode fast --output json',
      'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.setup.json'
    ],
    steps: [
      {
        kind: 'task',
        id: 'setup_status',
        title: 'Setup Status',
        task: 'setup.status',
        mutating: false,
        command: 'xyte-cli setup status --tenant <tenant-id> --output json'
      },
      {
        kind: 'task',
        id: 'config_doctor',
        title: 'Config Doctor',
        task: 'config.doctor',
        mutating: false,
        command: 'xyte-cli config doctor --tenant <tenant-id> --output json'
      },
      {
        kind: 'task',
        id: 'status_fast',
        title: 'Status Fast',
        task: 'status.fast',
        mutating: false,
        command: 'xyte-cli status --tenant <tenant-id> --mode fast --output json'
      },
      {
        kind: 'task',
        id: 'inspect_fleet_setup',
        title: 'Inspect Fleet Setup',
        task: 'inspect.fleet',
        inspect: { mode: 'fleet' },
        mutating: false,
        command: 'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.setup.json'
      }
    ]
  },
  'flow.incidents-delta-watch': {
    id: 'flow.incidents-delta-watch',
    title: 'Incidents Delta Watch',
    intent: 'Stream deterministic incident snapshots and deltas.',
    writeCapable: false,
    recipeCommands: [
      'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json',
      'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --output json --strict-json --out ./artifacts/xyte-watch.incidents.ndjson'
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
        command: 'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json'
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
        command: 'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --output json --strict-json --out ./artifacts/xyte-watch.incidents.ndjson'
      }
    ]
  },
  'flow.watch-to-triage': {
    id: 'flow.watch-to-triage',
    title: 'Watch To Triage',
    intent: 'Pivot from watch deltas into deterministic triage artifacts.',
    writeCapable: false,
    recipeCommands: [
      'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.triage.ndjson',
      'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.triage.json',
      'xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.triage.json',
      'xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.triage.json --out ./reports/xyte-triage.md --render markdown'
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
        command: 'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.triage.ndjson'
      },
      {
        kind: 'task',
        id: 'inspect_fleet_triage',
        title: 'Inspect Fleet Triage',
        task: 'inspect.fleet',
        inspect: { mode: 'fleet' },
        mutating: false,
        command: 'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.triage.json'
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
        command: 'xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.triage.json'
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
        command: 'xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.triage.json --out ./reports/xyte-triage.md --render markdown'
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
    intent: 'Run controlled org-scope remediation with explicit human gates.',
    writeCapable: true,
    recipeCommands: [
      'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.before.ndjson',
      [
        'xyte-cli api call organization.commands.getCommands \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}' \\`,
        `  --query-json '{"page":1,"per_page":20}'`
      ].join('\n'),
      [
        'xyte-cli api call organization.commands.sendCommand \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}' \\`,
        `  --body-json '{"command":"<valid-command-from-history>"}'`
      ].join('\n'),
      [
        'xyte-cli api call organization.devices.updateDevice \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}' \\`,
        `  --body-json '{"name":"<updated-device-name>"}'`
      ].join('\n'),
      [
        'xyte-cli api call organization.devices.getDevice \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}'`
      ].join('\n'),
      [
        'xyte-cli api call organization.tickets.sendMessage \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"ticket_id":"<ticket-id>"}' \\`,
        `  --query-json '{"message":"Operator approved remediation for incident <incident-id> on device <device-id>."}'`
      ].join('\n'),
      [
        'xyte-cli api call organization.incidents.closeIncident \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"incident_id":"<incident-id>"}'`
      ].join('\n'),
      'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.after.ndjson'
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
        command: 'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.before.ndjson'
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
        command: 'xyte-cli api call organization.commands.getCommands --tenant <tenant-id> --path-json {"device_id":"<device-id>"} --query-json {"page":1,"per_page":20}'
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
        command: 'xyte-cli api call organization.commands.sendCommand --tenant <tenant-id> --path-json {"device_id":"<device-id>"} --body-json {"command":"<valid-command-from-history>"}'
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
        command: 'xyte-cli api call organization.devices.updateDevice --tenant <tenant-id> --path-json {"device_id":"<device-id>"} --body-json {"name":"<updated-device-name>"}'
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
        command: 'xyte-cli api call organization.devices.getDevice --tenant <tenant-id> --path-json {"device_id":"<device-id>"}'
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
        command: 'xyte-cli api call organization.tickets.sendMessage --tenant <tenant-id> --path-json {"ticket_id":"<ticket-id>"} --query-json {"message":"Operator approved remediation for incident <incident-id> on device <device-id>."}'
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
          outputMode: 'envelope'
        },
        requiresContext: ['incident_id'],
        mutating: true,
        command: 'xyte-cli api call organization.incidents.closeIncident --tenant <tenant-id> --path-json {"incident_id":"<incident-id>"}'
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
        command: 'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.after.ndjson'
      }
    ]
  },
  'flow.daily-deep-dive-report': {
    id: 'flow.daily-deep-dive-report',
    title: 'Daily Deep Dive Report',
    intent: 'Produce daily deep-dive JSON and markdown report artifacts.',
    writeCapable: false,
    recipeCommands: [
      'xyte-cli setup status --tenant <tenant-id> --output json',
      'xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.daily.json',
      'xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.daily.json --out ./reports/xyte-daily.md --render markdown',
      'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.daily.json'
    ],
    steps: [
      {
        kind: 'task',
        id: 'setup_status_daily',
        title: 'Setup Status',
        task: 'setup.status',
        mutating: false,
        command: 'xyte-cli setup status --tenant <tenant-id> --output json'
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
        command: 'xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.daily.json'
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
        command: 'xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.daily.json --out ./reports/xyte-daily.md --render markdown'
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
        command: 'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.daily.json'
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
