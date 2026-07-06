import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { runUtilityPrepare, listUtilityPrepareActions } from '../src/workflows/utility-prepare';

function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('utility prepare workflow', () => {
  it('builds claim-device friendly contract with expected scaffolds', () => {
    const root = makeTempRoot('xyte-prepare-claim-');
    const inputPath = join(root, 'source.xlsx');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'placeholder', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.devices.claimDevice',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.schemaVersion).toBe('xyte.utility.prepare.v1');
    expect(result.actionKey).toBe('organization.devices.claimDevice');
    expect(result.mode).toBe('friendly');
    expect(result.entity).toBe('devices');
    expect(result.canonical.headers).toEqual(['name', 'space_id', 'sn', 'mac', 'cloud_id']);
    expect(result.suggestedCommands.next).toContain('Preflight gate');
    expect(result.suggestedCommands.apply).toContain('organization.devices.claimDevice');
    expect(result.suggestedCommands.apply).toContain('--body-json');
    expect(result.suggestedCommands.verify).toContain('organization.devices.getDevices');
    expect(existsSync(result.artifacts.primary)).toBe(true);
    expect(existsSync(result.artifacts.rejected)).toBe(true);
    expect(existsSync(result.artifacts.notes)).toBe(true);
  });

  it('builds space.import-tree friendly contract and csv scaffold', () => {
    const root = makeTempRoot('xyte-prepare-space-');
    const inputPath = join(root, 'tree.jpeg');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'placeholder', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'space.import-tree',
      outputDir: outDir
    });

    expect(result.actionKey).toBe('space.import-tree');
    expect(result.mode).toBe('friendly');
    expect(result.input.kind).toBe('image');
    expect(result.executionSupport).toBe('space.import-tree');
    expect(readFileSync(result.artifacts.primary, 'utf8')).toBe('path,space_type,config\n');
    expect(readFileSync(result.artifacts.rejected, 'utf8')).toBe('path,space_type,config,reject_reason\n');
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain('path: required');
    expect(notes).toContain('## Canonical JSON Shape');
    expect(notes).toContain('missing_path');
    expect(notes).toContain('## Safe Next Commands');
  });

  it('builds device.move friendly contract and csv scaffold', () => {
    const root = makeTempRoot('xyte-prepare-device-move-');
    const inputPath = join(root, 'source.json');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, '[]', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'device.move',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.mode).toBe('friendly');
    expect(result.executionSupport).toBe('device.move');
    expect(result.canonical.headers).toEqual([
      'device_id',
      'target_space_id',
      'device_name',
      'current_space_id',
      'target_space_name'
    ]);
    expect(result.suggestedCommands.apply).toContain('util move-devices');
    expect(readFileSync(result.artifacts.primary, 'utf8')).toBe(
      'device_id,target_space_id,device_name,current_space_id,target_space_name\n'
    );
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain('target_space_id: required');
    expect(notes).toContain('invalid_target_space_id');
  });

  it('builds generic endpoint contract with path/query/body canonical fields', () => {
    const root = makeTempRoot('xyte-prepare-generic-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.tickets.updateTicket',
      outputDir: outDir
    });

    expect(result.mode).toBe('generic');
    expect(result.canonical.headers).toEqual(['ticket_id', 'query_json', 'body_json']);
    expect(result.executionSupport).toBe('call-loop-only');
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain('ticket_id: required');
    expect(notes).not.toContain('invalid_device_ip');
    expect(notes).not.toContain('invalid_target_space_id');
  });

  it('builds generic note-create guidance without fake query params', () => {
    const root = makeTempRoot('xyte-prepare-note-create-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.notes.createDeviceNote',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.mode).toBe('generic');
    expect(result.canonical.headers).toEqual(['device_id', 'query_json', 'body_json']);
    expect(result.suggestedCommands.apply).toBe(
      `xyte-cli api call organization.notes.createDeviceNote --tenant acme --path-json '{"device_id":"<device_id>"}' --body-json '{"...":"..."}'`
    );
    expect(result.suggestedCommands.apply).not.toContain('--query-json');
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain(
      'query_json must be a valid JSON object string or empty; only documented query params are allowed: (none).'
    );
    expect(notes).toContain('body_json must be a valid JSON object string or empty.');
  });

  it('builds generic note-delete guidance without fake query or body params', () => {
    const root = makeTempRoot('xyte-prepare-note-delete-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.notes.deleteDeviceNote',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.mode).toBe('generic');
    expect(result.canonical.headers).toEqual(['device_id', 'id', 'query_json', 'body_json']);
    expect(result.suggestedCommands.apply).toBe(
      `xyte-cli api call organization.notes.deleteDeviceNote --tenant acme --path-json '{"device_id":"<device_id>","id":"<id>"}'`
    );
    expect(result.suggestedCommands.apply).not.toContain('--query-json');
    expect(result.suggestedCommands.apply).not.toContain('--body-json');
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain('body_json must be empty because this endpoint does not accept a request body.');
  });

  it('builds generic query-only write guidance without fake body params', () => {
    const root = makeTempRoot('xyte-prepare-query-write-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.tickets.sendMessage',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.mode).toBe('generic');
    expect(result.suggestedCommands.apply).toBe(
      `xyte-cli api call organization.tickets.sendMessage --tenant acme --path-json '{"ticket_id":"<ticket_id>"}' --query-json '{"message":"<message>"}'`
    );
    expect(result.suggestedCommands.apply).not.toContain('--body-json');
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain('only documented query params are allowed: message');
    expect(notes).toContain('body_json must be empty because this endpoint does not accept a request body.');
  });

  it('builds connector setup prepare-only scaffold', () => {
    const root = makeTempRoot('xyte-prepare-connectors-');
    const inputPath = join(root, 'connectors.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'raw', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.connectors.prepareSetup',
      outputDir: outDir
    });

    expect(result.executionSupport).toBe('prepare-only');
    expect(result.entity).toBe('connectors');
    expect(result.artifacts.primary).toBe(join(outDir, 'organization-connectors-preparesetup.csv'));
    expect(result.artifacts.rejected).toBe(join(outDir, 'organization-connectors-preparesetup.rejected.csv'));
    expect(result.artifacts.notes).toBe(join(outDir, 'organization-connectors-preparesetup.notes.md'));
    expect(readFileSync(result.artifacts.primary, 'utf8')).toBe(
      'label,platform,connectorName,targetSpace,targetSpaceId,authorizationOwner,deviceNameSource,sourceRow,notes\n'
    );
    expect(readFileSync(result.artifacts.rejected, 'utf8')).toBe(
      'label,platform,connectorName,targetSpace,targetSpaceId,authorizationOwner,deviceNameSource,sourceRow,notes,reject_reason\n'
    );
    expect(result.suggestedCommands.apply).toBe('No CLI execution is available for this prepare-only utility.');
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain('connectorName: required');
    expect(notes).toContain('targetSpace: required');
    expect(notes).toContain('authorizationOwner: required');
    expect(notes).toContain('unsupported_connector');
  });

  it('builds split team access prepare-only scaffolds', () => {
    const root = makeTempRoot('xyte-prepare-teamaccess-');
    const inputPath = join(root, 'team.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'raw', 'utf8');

    const groups = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.teamAccess.groups',
      outputDir: outDir
    });
    const users = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.teamAccess.users',
      outputDir: outDir
    });
    const memberships = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.teamAccess.memberships',
      outputDir: outDir
    });

    expect(groups.executionSupport).toBe('prepare-only');
    expect(users.executionSupport).toBe('prepare-only');
    expect(memberships.executionSupport).toBe('prepare-only');
    expect(readFileSync(groups.artifacts.primary, 'utf8')).toBe('label,groupName,iconName,sourceRow,notes\n');
    expect(readFileSync(groups.artifacts.rejected, 'utf8')).toBe(
      'label,groupName,iconName,sourceRow,notes,reject_reason\n'
    );
    expect(readFileSync(users.artifacts.primary, 'utf8')).toBe(
      'label,email,name,groupName,assignSupportSeat,sourceRow,notes\n'
    );
    expect(readFileSync(users.artifacts.rejected, 'utf8')).toBe(
      'label,email,name,groupName,assignSupportSeat,sourceRow,notes,reject_reason\n'
    );
    expect(readFileSync(memberships.artifacts.primary, 'utf8')).toBe('label,email,groupName,sourceRow,notes\n');
    expect(readFileSync(memberships.artifacts.rejected, 'utf8')).toBe(
      'label,email,groupName,sourceRow,notes,reject_reason\n'
    );
    expect(groups.artifacts.primary).toBe(join(outDir, 'organization-teamaccess-groups.csv'));
    expect(users.artifacts.primary).toBe(join(outDir, 'organization-teamaccess-users.csv'));
    expect(memberships.artifacts.primary).toBe(join(outDir, 'organization-teamaccess-memberships.csv'));
    expect(readFileSync(users.artifacts.notes, 'utf8')).toContain('invalid_email');
    expect(readFileSync(memberships.artifacts.notes, 'utf8')).toContain('missing_groupName');
  });

  it('adds send-command preflight guidance in suggested commands', () => {
    const root = makeTempRoot('xyte-prepare-send-command-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.commands.sendCommand',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.suggestedCommands.next).toContain('Preflight gate');
    expect(result.suggestedCommands.next).toContain('organization.devices.getDevice');
    expect(result.suggestedCommands.next).toContain('organization.models.getModel');
    expect(result.suggestedCommands.next).toContain('extra_params');
    expect(result.suggestedCommands.apply).toContain('organization.commands.sendCommand');
    expect(result.suggestedCommands.apply).toContain('"name"');
    expect(result.suggestedCommands.verify).toContain('organization.commands.getCommands');
  });

  it('adds update-device read-back verification guidance in suggested commands', () => {
    const root = makeTempRoot('xyte-prepare-update-device-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.devices.updateDevice',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.suggestedCommands.next).toContain('read back');
    expect(result.suggestedCommands.apply).toContain('organization.devices.updateDevice');
    expect(result.suggestedCommands.verify).toContain('organization.devices.getDevice');
  });

  it('uses the generated edge-claim scaffold path and resume-artifact guidance', () => {
    const root = makeTempRoot('xyte-prepare-edge-claim-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.edge.startClaim',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.executionSupport).toBe('edge.claim-batch');
    expect(result.artifacts.primary).toBe(join(outDir, 'organization-edge-startclaim.csv'));
    expect(result.artifacts.rejected).toBe(join(outDir, 'organization-edge-startclaim.rejected.csv'));
    expect(result.artifacts.notes).toBe(join(outDir, 'organization-edge-startclaim.notes.md'));
    expect(result.canonical.headers).toContain('skip_connectivity_check');
    expect(readFileSync(result.artifacts.primary, 'utf8')).toContain('skip_connectivity_check');
    expect(result.decodeRules.join(' ')).toContain('pre-claim ping');
    expect(result.suggestedCommands.apply).toContain(result.artifacts.primary);
    expect(result.suggestedCommands.apply).toContain('--report');
    expect(result.suggestedCommands.apply).toContain('--resume-artifact');
    expect(result.suggestedCommands.apply).toContain(join(outDir, 'edge-claim.apply.ndjson'));
    expect(result.suggestedCommands.apply).toContain(join(outDir, 'edge-claim.resume.ndjson'));
    expect(result.suggestedCommands.apply).not.toContain('--skip-connectivity-check');
    expect(result.suggestedCommands.next).toContain('--resume-artifact <path>');
    expect(result.suggestedCommands.next).not.toContain('--resume <run-id>');
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain('proxy_id: required');
    expect(notes).toContain('skip_connectivity_check: optional');
    expect(notes).toContain('invalid_custom_parameters');
    expect(notes).toContain('invalid_device_ip');
    expect(notes).toContain('invalid_space_id');
    expect(notes).toContain('invalid_skip_connectivity_check');
  });

  it('uses the generated edge params scaffold path and batch update guidance', () => {
    const root = makeTempRoot('xyte-prepare-edge-params-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'edge.params.update',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.executionSupport).toBe('edge.params-update-batch');
    expect(result.artifacts.primary).toBe(join(outDir, 'edge-params-update.csv'));
    expect(result.canonical.headers).toEqual(['device_id', 'set_json', 'expected_model_id']);
    expect(readFileSync(result.artifacts.primary, 'utf8')).toContain('set_json');
    expect(result.suggestedCommands.apply).toContain('xyte-cli edge update-params-batch');
    expect(result.suggestedCommands.apply).toContain('--report');
    expect(result.suggestedCommands.apply).toContain('--resume-artifact');
    expect(result.decodeRules.join(' ')).toContain('full replacement');
    const notes = readFileSync(result.artifacts.notes, 'utf8');
    expect(notes).toContain('device_id: required');
    expect(notes).toContain('set_json: required');
    expect(notes).toContain('invalid_set_json');
    expect(notes).toContain('unknown_parameter');
    expect(notes).toContain('unsupported_current_parameter');
    expect(notes).toContain('missing_required_parameter');
    expect(notes).toContain('masked_password_requires_value');
    expect(notes).toContain('model_mismatch');
    expect(notes).toContain('duplicate_device_id');
  });

  it('fails on unknown action and on scaffold collision without force', () => {
    const root = makeTempRoot('xyte-prepare-force-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    expect(() =>
      runUtilityPrepare({
        inputPath,
        actionKey: 'no.such.action',
        outputDir: outDir
      })
    ).toThrow('Unknown utility action');

    expect(() =>
      runUtilityPrepare({
        inputPath,
        actionKey: 'device.file-dumps.appendDumpFile',
        outputDir: outDir
      })
    ).toThrow('Unknown utility action');

    runUtilityPrepare({
      inputPath,
      actionKey: 'space.import-tree',
      outputDir: outDir
    });

    expect(() =>
      runUtilityPrepare({
        inputPath,
        actionKey: 'space.import-tree',
        outputDir: outDir
      })
    ).toThrow('--force');
  });

  it('lists actions and validates prepare schema output', () => {
    const actions = listUtilityPrepareActions();
    expect(actions[0]?.mode).toBe('friendly');
    expect(actions.some((item) => item.actionKey === 'organization.devices.claimDevice')).toBe(true);
    expect(actions.some((item) => item.actionKey === 'organization.connectors.prepareSetup')).toBe(true);
    expect(actions.some((item) => item.actionKey === 'organization.teamAccess.groups')).toBe(true);
    expect(actions.some((item) => item.actionKey === 'organization.teamAccess.users')).toBe(true);
    expect(actions.some((item) => item.actionKey === 'organization.teamAccess.memberships')).toBe(true);
    expect(actions.some((item) => item.actionKey === 'device.move')).toBe(true);
    expect(actions.some((item) => item.actionKey === 'edge.params.update')).toBe(true);
    expect(actions.some((item) => item.actionKey === 'space.import-tree')).toBe(true);
    expect(listUtilityPrepareActions({ mode: 'friendly' }).every((item) => item.mode === 'friendly')).toBe(true);
    expect(listUtilityPrepareActions({ executionSupport: 'edge.claim-batch' }).map((item) => item.actionKey)).toEqual([
      'organization.edge.startClaim'
    ]);
    expect(listUtilityPrepareActions({ executionSupport: 'edge.params-update-batch' }).map((item) => item.actionKey)).toEqual([
      'edge.params.update'
    ]);
    expect(listUtilityPrepareActions({ executionSupport: 'prepare-only' }).map((item) => item.actionKey)).toEqual([
      'organization.connectors.prepareSetup',
      'organization.teamAccess.groups',
      'organization.teamAccess.memberships',
      'organization.teamAccess.users'
    ]);

    const root = makeTempRoot('xyte-prepare-schema-');
    const inputPath = join(root, 'source.md');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, '# source', 'utf8');

    const schemaPath = join(process.cwd(), 'docs/schemas/utility-prepare.v1.schema.json');
    const skillSchemaPath = join(process.cwd(), 'skills/xyte-cli/schemas/utility-prepare.v1.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    const skillSchema = JSON.parse(readFileSync(skillSchemaPath, 'utf8')) as Record<string, unknown>;
    expect(skillSchema).toEqual(schema);

    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'space.import-tree',
      outputDir: outDir
    });

    expect(validate(result)).toBe(true);
    expect(validate.errors).toBeNull();

    const prepareOnlyResult = runUtilityPrepare({
      inputPath,
      actionKey: 'organization.connectors.prepareSetup',
      outputDir: outDir,
      force: true
    });

    expect(validate(prepareOnlyResult)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
