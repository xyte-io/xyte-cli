import { DEFAULT_WATCH_PROFILE, type WatchProfile } from '../contracts/watch-frame';

export type BuiltInFlowId =
  | 'flow.setup-readiness-10m'
  | 'flow.incidents-delta-watch'
  | 'flow.watch-to-triage'
  | 'flow.guided-remediation'
  | 'flow.device-command'
  | 'flow.device-migration'
  | 'flow.daily-deep-dive-report'
  | 'flow.edge-model-discovery'
  | 'flow.edge-claim'
  | 'flow.edge-claim-batch'
  | 'flow.edge-params-update'
  | 'flow.edge-params-update-batch'
  | 'flow.edge-ping';

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
  | 'device.match'
  | 'device.move-batch'
  | 'device.verify-batch'
  | 'space.import-tree'
  | 'command.poll'
  | 'edge.claim'
  | 'edge.claim-batch'
  | 'edge.params-update'
  | 'edge.params-update-batch'
  | 'edge.ping';

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
    profile: WatchProfile;
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
    fleetFromStepId?: string;
    verificationFromStepId?: string;
  };
  call?: {
    endpointKey: string;
    path?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
    outputMode?: 'raw' | 'envelope';
    /** Extract a context key from the response: find the first item in arrayPath that has a string valueField. */
    outputContext?: { contextKey: string; arrayPath: string; valueField: string };
  };
  utilityPrepare?: {
    actionKey: string;
    inputPath: string;
    outputDir: string;
    primaryFormat?: 'csv' | 'jsonl';
  };
  deviceMatch?: {
    sourcePath: string;
    targetPath: string;
    sourceField: string;
    targetField: string;
    outputPath: string;
  };
  deviceMoveBatch?: {
    inputPath: string;
    apply: boolean;
    reportPath: string;
    continueOnError?: boolean;
  };
  deviceVerifyBatch?: {
    inputPath: string;
  };
  spaceImportTree?: {
    inputPath: string;
    apply: boolean;
    reportPath: string;
  };
  commandPoll?: {
    sendStepId: string;
    enabledKey: string;
    intervalMsKey: string;
    timeoutMsKey: string;
  };
  edgeClaim?: {
    pollIntervalMsKey?: string;
    pollTimeoutMsKey?: string;
  };
  edgeClaimBatch?: {
    inputPath: string;
    apply: boolean;
    reportPath: string;
    resumePath: string;
    pollIntervalMsKey?: string;
    pollTimeoutMsKey?: string;
  };
  edgeParamsUpdate?: {
    apply: boolean;
  };
  edgeParamsUpdateBatch?: {
    inputPath: string;
    apply: boolean;
    reportPath: string;
    resumePath: string;
  };
  edgePing?: {
    pollIntervalMsKey?: string;
    pollTimeoutMsKey?: string;
  };
}

export interface FlowGateStep extends FlowStepBase {
  kind: 'gate';
  mutating: boolean;
  detail: string;
  pauseOnFirstApply?: boolean;
}

export type FlowStep = FlowTaskStep | FlowGateStep;

export interface BuiltInFlowDefinition {
  id: BuiltInFlowId;
  title: string;
  intent: string;
  writeCapable: boolean;
  recipeCommands: string[];
  steps: FlowStep[];
  /** Context keys to derive when missing. Values may contain {{key}} placeholders resolved from the current context. */
  contextDefaults?: Record<string, string>;
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
          profile: DEFAULT_WATCH_PROFILE,
          once: true
        },
        mutating: false,
        command:
          'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json'
      },
      {
        kind: 'task',
        id: 'watch_loop',
        title: 'Watch Loop',
        task: 'watch',
        watch: {
          profile: DEFAULT_WATCH_PROFILE,
          once: false,
          intervalMs: 2000,
          maxPolls: 30
        },
        mutating: false,
        command:
          'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --output json --strict-json --out ./artifacts/xyte-watch.incidents.ndjson'
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
          profile: DEFAULT_WATCH_PROFILE,
          once: true
        },
        mutating: false,
        command:
          'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.triage.ndjson'
      },
      {
        kind: 'task',
        id: 'inspect_fleet_triage',
        title: 'Inspect Fleet Triage',
        task: 'inspect.fleet',
        inspect: { mode: 'fleet' },
        mutating: false,
        command:
          'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.triage.json'
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
        command:
          'xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.triage.json'
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
        command:
          'xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.triage.json --out ./reports/xyte-triage.md --render markdown'
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
    contextDefaults: { updated_device_name: 'Remediated {{device_id}}' },
    recipeCommands: [
      'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.before.ndjson',
      [
        'xyte-cli api call organization.devices.getDevice \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}'`
      ].join('\n'),
      [
        'xyte-cli edge models describe \\',
        '  --tenant <tenant-id> \\',
        '  --model-id <model-id-from-device>'
      ].join('\n'),
      [
        'xyte-cli api call organization.commands.sendCommand \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}' \\`,
        `  --body-json '{"name":"<commands[].name>","extra_params":{}}'`
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
          profile: DEFAULT_WATCH_PROFILE,
          once: true
        },
        mutating: false,
        command:
          'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.before.ndjson'
      },
      {
        kind: 'task',
        id: 'command_device_get',
        title: 'Get Device For Command',
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
        command:
          'xyte-cli api call organization.devices.getDevice --tenant <tenant-id> --path-json {"device_id":"<device-id>"}'
      },
      {
        kind: 'task',
        id: 'command_model_describe',
        title: 'Describe Command Model',
        task: 'call',
        call: {
          endpointKey: 'organization.models.getModel',
          path: {
            id: '{{device_model_id}}'
          },
          outputMode: 'envelope',
          outputContext: { contextKey: 'command', arrayPath: 'commands', valueField: 'name' }
        },
        requiresContext: ['device_model_id'],
        mutating: false,
        command: 'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>'
      },
      {
        kind: 'gate',
        id: 'gate_send_command',
        title: 'Approve Send Command',
        mutating: true,
        detail:
          'Human approval required before organization.commands.sendCommand. Choose commands[].name from organization.models.getModel; pass command_extra_params_json for custom_fields and command_file_id when with_file is true.',
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
            name: '{{command}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['device_id', 'command'],
        mutating: true,
        command:
          'xyte-cli api call organization.commands.sendCommand --tenant <tenant-id> --path-json {"device_id":"<device-id>"} --body-json {"name":"<commands[].name>","extra_params":{}}'
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
        command:
          'xyte-cli api call organization.devices.updateDevice --tenant <tenant-id> --path-json {"device_id":"<device-id>"} --body-json {"name":"<updated-device-name>"}'
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
        command:
          'xyte-cli api call organization.devices.getDevice --tenant <tenant-id> --path-json {"device_id":"<device-id>"}'
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
        command:
          'xyte-cli api call organization.tickets.sendMessage --tenant <tenant-id> --path-json {"ticket_id":"<ticket-id>"} --query-json {"message":"Operator approved remediation for incident <incident-id> on device <device-id>."}'
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
        command:
          'xyte-cli api call organization.incidents.closeIncident --tenant <tenant-id> --path-json {"incident_id":"<incident-id>"}'
      },
      {
        kind: 'task',
        id: 'watch_after',
        title: 'Watch After',
        task: 'watch',
        watch: {
          profile: DEFAULT_WATCH_PROFILE,
          once: true
        },
        mutating: false,
        command:
          'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.after.ndjson'
      }
    ]
  },
  'flow.device-command': {
    id: 'flow.device-command',
    title: 'Device Command',
    intent:
      'Fetch model-supported commands for one device, send one after explicit approval, and optionally poll its status.',
    writeCapable: true,
    recipeCommands: [
      [
        'xyte-cli api call organization.devices.getDevice \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}'`
      ].join('\n'),
      [
        'xyte-cli edge models describe \\',
        '  --tenant <tenant-id> \\',
        '  --model-id <model-id-from-device>'
      ].join('\n'),
      [
        'xyte-cli api call organization.commands.sendCommand \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}' \\`,
        `  --body-json '{"name":"<commands[].name>","extra_params":{}}'`
      ].join('\n'),
      [
        'xyte-cli api call organization.commands.getCommands \\',
        '  --tenant <tenant-id> \\',
        `  --path-json '{"device_id":"<device-id>"}' \\`,
        `  --query-json '{"page":1,"per_page":500}'`
      ].join('\n')
    ],
    steps: [
      {
        kind: 'task',
        id: 'device_command_device_get',
        title: 'Get Device For Command',
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
        command:
          'xyte-cli api call organization.devices.getDevice --tenant <tenant-id> --path-json {"device_id":"<device-id>"}'
      },
      {
        kind: 'task',
        id: 'device_command_model_describe',
        title: 'Describe Command Model',
        task: 'call',
        call: {
          endpointKey: 'organization.models.getModel',
          path: {
            id: '{{device_model_id}}'
          },
          outputMode: 'envelope',
          outputContext: { contextKey: 'command', arrayPath: 'commands', valueField: 'name' }
        },
        requiresContext: ['device_model_id'],
        mutating: false,
        command: 'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>'
      },
      {
        kind: 'gate',
        id: 'gate_device_command_send',
        title: 'Approve Device Command',
        mutating: true,
        detail:
          'Human approval required before organization.commands.sendCommand. Provide --var command=<commands[].name>; pass command_extra_params_json for custom_fields and command_file_id when with_file is true.',
        command: 'Human decision gate before device sendCommand'
      },
      {
        kind: 'task',
        id: 'device_command_send',
        title: 'Send Device Command',
        task: 'call',
        call: {
          endpointKey: 'organization.commands.sendCommand',
          path: {
            device_id: '{{device_id}}'
          },
          body: {
            name: '{{command}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['device_id', 'command'],
        mutating: true,
        command:
          'xyte-cli api call organization.commands.sendCommand --tenant <tenant-id> --path-json {"device_id":"<device-id>"} --body-json {"name":"<commands[].name>","extra_params":{}}'
      },
      {
        kind: 'task',
        id: 'device_command_status',
        title: 'Poll Device Command Status',
        task: 'command.poll',
        commandPoll: {
          sendStepId: 'device_command_send',
          enabledKey: 'command_poll',
          intervalMsKey: 'command_poll_interval_ms',
          timeoutMsKey: 'command_poll_timeout_ms'
        },
        mutating: false,
        command:
          'xyte-cli api call organization.commands.getCommands --tenant <tenant-id> --path-json {"device_id":"<device-id>"} --query-json {"page":1,"per_page":500}'
      }
    ]
  },
  'flow.device-migration': {
    id: 'flow.device-migration',
    title: 'Device Migration',
    intent: 'Inventory, match, dry-run, execute, and verify device-to-space migration with human gates.',
    writeCapable: true,
    recipeCommands: [
      'mkdir -p ./artifacts ./reports',
      `xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --query-json '{"space_id":"<source-space-id>","page":1,"per_page":100}' --output-mode envelope --output json > ./artifacts/source-devices.page-1.json`,
      '# Repeat page 2, 3, ... until the response reports no continuation (`next_page` is null/absent, or `has_next_page=false` on tenants that return that field), then combine items into ./artifacts/source-devices.json.',
      'xyte-cli api call organization.spaces.getSpaces --tenant <tenant-id> --query path_includes=<target-path> --output json > ./artifacts/target-spaces.json',
      'xyte-cli util match --tenant <tenant-id> --source ./artifacts/source-devices.json --target ./artifacts/target-spaces.json --source-field name --target-field name --out ./artifacts/device-moves.csv',
      'xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/device-moves.csv.summary.json --out ./reports/device-migration-pre.md --render markdown',
      'xyte-cli util move-devices --tenant <tenant-id> --input ./artifacts/device-moves.csv --report ./artifacts/device-migration.dry-run.ndjson',
      'xyte-cli util move-devices --tenant <tenant-id> --input ./artifacts/device-moves.csv --apply --report ./artifacts/device-migration.apply.ndjson > ./artifacts/device-migration.apply.json',
      'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.device-migration.json'
    ],
    steps: [
      {
        kind: 'task',
        id: 'inventory_source',
        title: 'Inventory Source Devices',
        task: 'call',
        call: {
          endpointKey: 'organization.devices.getDevices',
          query: {
            space_id: '{{source_space_id}}',
            page: 1,
            per_page: 100
          },
          outputMode: 'envelope'
        },
        requiresContext: ['source_space_id'],
        mutating: false,
        command:
          `xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --query-json '{"space_id":"<source-space-id>","page":1,"per_page":100}' --output-mode envelope --output json > ./artifacts/source-devices.page-1.json`
      },
      {
        kind: 'task',
        id: 'inventory_target',
        title: 'Inventory Target Spaces',
        task: 'call',
        call: {
          endpointKey: 'organization.spaces.getSpaces',
          query: {
            path_includes: '{{target_path_includes}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['target_path_includes'],
        mutating: false,
        command:
          'xyte-cli api call organization.spaces.getSpaces --tenant <tenant-id> --query path_includes=<target-path> --output json > ./artifacts/target-spaces.json'
      },
      {
        kind: 'task',
        id: 'match_devices',
        title: 'Match Devices',
        task: 'device.match',
        deviceMatch: {
          sourcePath: '{{inventory_source_artifact}}',
          targetPath: '{{inventory_target_artifact}}',
          sourceField: 'name',
          targetField: 'name',
          outputPath: 'device-moves.csv'
        },
        mutating: false,
        command:
          'xyte-cli util match --tenant <tenant-id> --source ./artifacts/source-devices.json --target ./artifacts/target-spaces.json --source-field name --target-field name --out ./artifacts/device-moves.csv'
      },
      {
        kind: 'task',
        id: 'pre_migration_report',
        title: 'Pre-Migration Report',
        task: 'report.generate',
        report: {
          inputFromStepId: 'match_devices',
          outFileName: 'device-migration-pre.md',
          format: 'markdown'
        },
        mutating: false,
        command:
          'xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/device-moves.csv.summary.json --out ./reports/device-migration-pre.md --render markdown'
      },
      {
        kind: 'gate',
        id: 'gate_approve_mapping',
        title: 'Approve Mapping',
        mutating: false,
        detail: 'Human approval required before dry-running the move batch.',
        command: 'Human decision gate before dry-run device migration'
      },
      {
        kind: 'task',
        id: 'dry_run_moves',
        title: 'Dry Run Device Moves',
        task: 'device.move-batch',
        deviceMoveBatch: {
          inputPath: '{{match_devices_output}}',
          apply: false,
          reportPath: 'device-migration.dry-run.ndjson'
        },
        mutating: false,
        command:
          'xyte-cli util move-devices --tenant <tenant-id> --input ./artifacts/device-moves.csv --report ./artifacts/device-migration.dry-run.ndjson'
      },
      {
        kind: 'gate',
        id: 'gate_approve_execution',
        title: 'Approve Execution',
        mutating: true,
        detail: 'Human approval required before executing device moves.',
        command: 'Human decision gate before apply device migration'
      },
      {
        kind: 'task',
        id: 'execute_moves',
        title: 'Execute Device Moves',
        task: 'device.move-batch',
        deviceMoveBatch: {
          inputPath: '{{match_devices_output}}',
          apply: true,
          reportPath: 'device-migration.apply.ndjson'
        },
        mutating: true,
        command:
          'xyte-cli util move-devices --tenant <tenant-id> --input ./artifacts/device-moves.csv --apply --report ./artifacts/device-migration.apply.ndjson'
      },
      {
        kind: 'task',
        id: 'verify_fleet',
        title: 'Verify Fleet',
        task: 'inspect.fleet',
        inspect: { mode: 'fleet' },
        mutating: false,
        command:
          'xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.device-migration.json'
      },
      {
        kind: 'task',
        id: 'verify_moved_devices',
        title: 'Verify Moved Devices',
        task: 'device.verify-batch',
        deviceVerifyBatch: {
          inputPath: '{{match_devices_output}}'
        },
        mutating: false,
        command:
          'Flow runner verifies the planned device set against their target spaces using ./artifacts/device-moves.csv.'
      },
      {
        kind: 'task',
        id: 'post_migration_report',
        title: 'Post-Migration Report',
        task: 'report.generate',
        report: {
          inputFromStepId: 'execute_moves',
          outFileName: 'device-migration-post.md',
          format: 'markdown',
          fleetFromStepId: 'verify_fleet',
          verificationFromStepId: 'verify_moved_devices'
        },
        mutating: false,
        command: 'Flow runner composes the post-migration report from execution and verification artifacts.'
      }
    ]
  },
  'flow.edge-model-discovery': {
    id: 'flow.edge-model-discovery',
    title: 'Edge Model Discovery',
    intent: 'List Edge-capable models and describe one model to discover supported custom parameters and commands.',
    writeCapable: false,
    recipeCommands: [
      'xyte-cli edge models list --tenant <tenant-id> --page 1 --per-page 100',
      'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>'
    ],
    steps: [
      {
        kind: 'task',
        id: 'edge_models_list',
        title: 'List Edge Models',
        task: 'call',
        call: {
          endpointKey: 'organization.models.getModels',
          query: {
            edge_only: true,
            page: 1,
            per_page: 100
          },
          outputMode: 'envelope',
          outputContext: { contextKey: 'edge_model_id', arrayPath: 'items', valueField: 'id' }
        },
        mutating: false,
        command: 'xyte-cli edge models list --tenant <tenant-id> --page 1 --per-page 100'
      },
      {
        kind: 'task',
        id: 'edge_model_describe',
        title: 'Describe Edge Model',
        task: 'call',
        call: {
          endpointKey: 'organization.models.getModel',
          path: {
            id: '{{edge_model_id}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['edge_model_id'],
        mutating: false,
        command: 'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>'
      }
    ]
  },
  'flow.edge-claim': {
    id: 'flow.edge-claim',
    title: 'Edge Claim',
    intent: 'Claim a single device behind an Edge proxy and poll to terminal state.',
    writeCapable: true,
    recipeCommands: [
      'xyte-cli edge models list --tenant <tenant-id> --search <model-or-alias> --page 1 --per-page 100',
      'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>',
      "xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --device-model-id <model-id> --space-id <space-id> [--mac <mac>] [--sn <serial>] [--custom-parameters '<json>'] --plan",
      "xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --device-model-id <model-id> --space-id <space-id> [--mac <mac>] [--sn <serial>] [--custom-parameters '<json>'] --apply"
    ],
    steps: [
      {
        kind: 'task',
        id: 'edge_claim_models_list',
        title: 'List Edge Models',
        task: 'call',
        call: {
          endpointKey: 'organization.models.getModels',
          query: {
            edge_only: true,
            page: 1,
            per_page: 100
          },
          outputMode: 'envelope',
          outputContext: { contextKey: 'device_model_id', arrayPath: 'items', valueField: 'id' }
        },
        mutating: false,
        command: 'xyte-cli edge models list --tenant <tenant-id> --page 1 --per-page 100'
      },
      {
        kind: 'task',
        id: 'edge_claim_model_describe',
        title: 'Describe Edge Model',
        task: 'call',
        call: {
          endpointKey: 'organization.models.getModel',
          path: {
            id: '{{device_model_id}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['device_model_id'],
        mutating: false,
        command: 'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>'
      },
      {
        kind: 'gate',
        id: 'gate_edge_claim',
        title: 'Approve Edge Claim',
        mutating: true,
        detail: 'Human approval required before initiating edge claim.',
        command: 'Human decision gate before edge claim'
      },
      {
        kind: 'task',
        id: 'edge_claim_single',
        title: 'Edge Claim Single',
        task: 'edge.claim',
        edgeClaim: {},
        requiresContext: ['proxy_id', 'device_ip', 'device_model_id', 'space_id'],
        mutating: true,
        command:
          "xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --device-model-id <model-id> --space-id <space-id> [--mac <mac>] [--sn <serial>] [--custom-parameters '<json>'] --apply"
      }
    ]
  },
  'flow.edge-claim-batch': {
    id: 'flow.edge-claim-batch',
    title: 'Edge Claim Batch',
    intent:
      'Claim many devices behind one or more Edge proxies from a prepared CSV; rows that do not skip connectivity checks run a pre-claim ping inside the batch.',
    writeCapable: true,
    recipeCommands: [
      'xyte-cli edge models list --tenant <tenant-id> --search <model-or-alias> --page 1 --per-page 100',
      'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>',
      'xyte-cli util prepare --action organization.edge.startClaim --tenant <tenant-id> --input ./devices.xlsx --output-dir ./prepared',
      'xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --plan',
      'xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --apply --report ./artifacts/edge-claim.report.ndjson --resume-artifact ./artifacts/edge-claim.resume.ndjson'
    ],
    steps: [
      {
        kind: 'task',
        id: 'edge_claim_batch_models_list',
        title: 'List Edge Models',
        task: 'call',
        call: {
          endpointKey: 'organization.models.getModels',
          query: {
            edge_only: true,
            page: 1,
            per_page: 100
          },
          outputMode: 'envelope',
          outputContext: { contextKey: 'device_model_id', arrayPath: 'items', valueField: 'id' }
        },
        mutating: false,
        command: 'xyte-cli edge models list --tenant <tenant-id> --page 1 --per-page 100'
      },
      {
        kind: 'task',
        id: 'edge_claim_batch_model_describe',
        title: 'Describe Edge Model',
        task: 'call',
        call: {
          endpointKey: 'organization.models.getModel',
          path: {
            id: '{{device_model_id}}'
          },
          outputMode: 'envelope'
        },
        requiresContext: ['device_model_id'],
        mutating: false,
        command: 'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>'
      },
      {
        kind: 'task',
        id: 'edge_claim_prepare',
        title: 'Prepare Edge Claim CSV',
        task: 'utility.prepare',
        utilityPrepare: {
          actionKey: 'organization.edge.startClaim',
          inputPath: '{{edge_claim_input_path}}',
          outputDir: 'edge-claim'
        },
        requiresContext: ['edge_claim_input_path'],
        mutating: false,
        command:
          'xyte-cli util prepare --action organization.edge.startClaim --tenant <tenant-id> --input ./devices.xlsx --output-dir ./artifacts/edge-claim'
      },
      {
        kind: 'gate',
        id: 'gate_edge_claim_prepare_review',
        title: 'Review Prepared Edge Claim CSV',
        mutating: false,
        pauseOnFirstApply: true,
        detail:
          'Populate and review the prepared edge-claim CSV before running the batch dry run; blank skip_connectivity_check means the batch will ping before claim.',
        command: 'Human decision gate after reviewing organization-edge-startclaim.csv'
      },
      {
        kind: 'task',
        id: 'edge_claim_dry_run',
        title: 'Edge Claim Dry Run',
        task: 'edge.claim-batch',
        edgeClaimBatch: {
          inputPath: '{{edge_claim_prepare_csv}}',
          apply: false,
          reportPath: 'edge-claim.dry-run.ndjson',
          resumePath: 'edge-claim.resume.ndjson'
        },
        mutating: false,
        command:
          'xyte-cli edge claim-batch --tenant <tenant-id> --input ./artifacts/edge-claim/organization-edge-startclaim.csv --plan'
      },
      {
        kind: 'gate',
        id: 'gate_edge_claim_batch_apply',
        title: 'Approve Edge Claim Batch',
        mutating: true,
        detail: 'Human approval required before applying edge claim batch; non-skip rows will ping before startClaim.',
        command: 'Human decision gate before edge claim batch apply'
      },
      {
        kind: 'task',
        id: 'edge_claim_apply',
        title: 'Edge Claim Apply',
        task: 'edge.claim-batch',
        edgeClaimBatch: {
          inputPath: '{{edge_claim_prepare_csv}}',
          apply: true,
          reportPath: 'edge-claim.apply.ndjson',
          resumePath: 'edge-claim.resume.ndjson'
        },
        mutating: true,
        command:
          'xyte-cli edge claim-batch --tenant <tenant-id> --input ./artifacts/edge-claim/organization-edge-startclaim.csv --apply --report ./artifacts/edge-claim.apply.ndjson --resume-artifact ./artifacts/edge-claim.resume.ndjson'
      }
    ]
  },
  'flow.edge-params-update': {
    id: 'flow.edge-params-update',
    title: 'Edge Params Update',
    intent:
      'Safely update custom parameters on one already-claimed Edge device by planning a full replacement, applying it, and verifying read-back.',
    writeCapable: true,
    recipeCommands: [
      'xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>',
      'xyte-cli edge update-params --tenant <tenant-id> --device-id <device-id> --set-json \'{"Port":"161"}\' --plan',
      'xyte-cli edge update-params --tenant <tenant-id> --device-id <device-id> --set-json \'{"Port":"161"}\' --apply'
    ],
    steps: [
      {
        kind: 'task',
        id: 'edge_params_plan',
        title: 'Plan Edge Params Update',
        task: 'edge.params-update',
        edgeParamsUpdate: {
          apply: false
        },
        requiresContext: ['device_id', 'set_json'],
        mutating: false,
        command:
          'xyte-cli edge update-params --tenant <tenant-id> --device-id <device-id> --set-json \'{"Port":"161"}\' --plan'
      },
      {
        kind: 'gate',
        id: 'gate_edge_params_apply',
        title: 'Approve Edge Params Update',
        mutating: true,
        detail:
          'Human approval required before applying the full custom_parameters replacement to the already-claimed Edge device.',
        command: 'Human decision gate before edge custom-parameter update'
      },
      {
        kind: 'task',
        id: 'edge_params_apply',
        title: 'Apply Edge Params Update',
        task: 'edge.params-update',
        edgeParamsUpdate: {
          apply: true
        },
        requiresContext: ['device_id', 'set_json'],
        mutating: true,
        command:
          'xyte-cli edge update-params --tenant <tenant-id> --device-id <device-id> --set-json \'{"Port":"161"}\' --apply'
      }
    ]
  },
  'flow.edge-params-update-batch': {
    id: 'flow.edge-params-update-batch',
    title: 'Edge Params Update Batch',
    intent:
      'Safely update custom parameters on many already-claimed Edge devices with prepared rows, dry-run reports, apply reports, and resume artifacts.',
    writeCapable: true,
    recipeCommands: [
      'xyte-cli util prepare --action edge.params.update --tenant <tenant-id> --input ./edge-params.xlsx --output-dir ./prepared',
      'xyte-cli edge update-params-batch --tenant <tenant-id> --input ./prepared/edge-params-update.csv --plan --report ./artifacts/edge-params.plan.ndjson',
      'xyte-cli edge update-params-batch --tenant <tenant-id> --input ./prepared/edge-params-update.csv --apply --report ./artifacts/edge-params.apply.ndjson --resume-artifact ./artifacts/edge-params.resume.ndjson'
    ],
    steps: [
      {
        kind: 'task',
        id: 'edge_params_prepare',
        title: 'Prepare Edge Params CSV',
        task: 'utility.prepare',
        utilityPrepare: {
          actionKey: 'edge.params.update',
          inputPath: '{{edge_params_input_path}}',
          outputDir: 'edge-params-update'
        },
        requiresContext: ['edge_params_input_path'],
        mutating: false,
        command:
          'xyte-cli util prepare --action edge.params.update --tenant <tenant-id> --input ./edge-params.xlsx --output-dir ./artifacts/edge-params-update'
      },
      {
        kind: 'gate',
        id: 'gate_edge_params_prepare_review',
        title: 'Review Prepared Edge Params CSV',
        mutating: false,
        pauseOnFirstApply: true,
        detail:
          'Populate and review device_id,set_json,expected_model_id rows before the dry run; set_json must contain explicit parameter labels and must not contain masked passwords.',
        command: 'Human decision gate after reviewing edge-params-update.csv'
      },
      {
        kind: 'task',
        id: 'edge_params_dry_run',
        title: 'Edge Params Dry Run',
        task: 'edge.params-update-batch',
        edgeParamsUpdateBatch: {
          inputPath: '{{edge_params_update_csv}}',
          apply: false,
          reportPath: 'edge-params.dry-run.ndjson',
          resumePath: 'edge-params.resume.ndjson'
        },
        mutating: false,
        command:
          'xyte-cli edge update-params-batch --tenant <tenant-id> --input ./artifacts/edge-params-update/edge-params-update.csv --plan --report ./artifacts/edge-params.dry-run.ndjson'
      },
      {
        kind: 'gate',
        id: 'gate_edge_params_batch_apply',
        title: 'Approve Edge Params Batch',
        mutating: true,
        detail:
          'Human approval required before applying already-claimed Edge custom-parameter updates; every row sends a full replacement body.',
        command: 'Human decision gate before edge params batch apply'
      },
      {
        kind: 'task',
        id: 'edge_params_apply',
        title: 'Edge Params Apply',
        task: 'edge.params-update-batch',
        edgeParamsUpdateBatch: {
          inputPath: '{{edge_params_update_csv}}',
          apply: true,
          reportPath: 'edge-params.apply.ndjson',
          resumePath: 'edge-params.resume.ndjson'
        },
        mutating: true,
        command:
          'xyte-cli edge update-params-batch --tenant <tenant-id> --input ./artifacts/edge-params-update/edge-params-update.csv --apply --report ./artifacts/edge-params.apply.ndjson --resume-artifact ./artifacts/edge-params.resume.ndjson'
      }
    ]
  },
  'flow.edge-ping': {
    id: 'flow.edge-ping',
    title: 'Edge Ping',
    intent: 'Probe connectivity for a single device behind an Edge proxy.',
    writeCapable: true,
    recipeCommands: [
      'xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --plan',
      'xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --apply'
    ],
    steps: [
      {
        kind: 'gate',
        id: 'gate_edge_ping',
        title: 'Approve Edge Ping',
        mutating: true,
        detail: 'Human approval required before initiating edge ping.',
        command: 'Human decision gate before edge ping'
      },
      {
        kind: 'task',
        id: 'edge_ping_single',
        title: 'Edge Ping Single',
        task: 'edge.ping',
        edgePing: {},
        requiresContext: ['proxy_id', 'device_ip'],
        mutating: true,
        command: 'xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --apply'
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
        command:
          'xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.daily.json'
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
        command:
          'xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.daily.json --out ./reports/xyte-daily.md --render markdown'
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

export const UTILITY_PREPARE_CONTEXT_KEY: Record<string, string> = {
  'space.import-tree': 'space_import_tree_csv',
  'organization.devices.claimDevice': 'claim_prepare_csv',
  'device.move': 'device_move_csv',
  'organization.edge.startClaim': 'edge_claim_prepare_csv',
  'edge.params.update': 'edge_params_update_csv'
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
