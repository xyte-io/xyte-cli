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
    expect(notes).toContain('## JSONL Example');
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
    expect(result.suggestedCommands.apply).toContain('organization.commands.sendCommand');
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
    expect(actions.some((item) => item.actionKey === 'device.move')).toBe(true);
    expect(actions.some((item) => item.actionKey === 'space.import-tree')).toBe(true);
    expect(listUtilityPrepareActions({ mode: 'friendly' }).every((item) => item.mode === 'friendly')).toBe(true);
    expect(
      listUtilityPrepareActions({ executionSupport: 'edge.claim-batch' }).map((item) => item.actionKey)
    ).toEqual(['organization.edge.startClaim']);

    const root = makeTempRoot('xyte-prepare-schema-');
    const inputPath = join(root, 'source.md');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, '# source', 'utf8');

    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs/schemas/utility-prepare.v1.schema.json'), 'utf8')
    ) as Record<string, unknown>;
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);

    const result = runUtilityPrepare({
      inputPath,
      actionKey: 'space.import-tree',
      outputDir: outDir
    });

    expect(validate(result)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
