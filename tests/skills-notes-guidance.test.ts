import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import endpoints from '../src/api-catalog/public-endpoints.json';

const NOTE_KEYS = [
  'organization.notes.createDeviceNote',
  'organization.notes.createSpaceNote',
  'organization.notes.deleteDeviceNote',
  'organization.notes.deleteSpaceNote',
  'organization.notes.getAllDeviceNotes',
  'organization.notes.getAllSpaceNotes',
  'organization.notes.getDeviceNotes',
  'organization.notes.getSpaceNotes'
];

function read(relPath: string): string {
  return readFileSync(resolve(__dirname, '..', relPath), 'utf8');
}

describe('notes endpoint docs and skill guidance', () => {
  it('documents all notes endpoint keys in the shipped endpoint reference', () => {
    const content = read('skills/xyte-cli/references/endpoints.md');

    for (const key of NOTE_KEYS) {
      expect(content).toContain(key);
    }
    expect(content).toContain('explicit user approval');
    expect(content).toContain('created_by: null');
  });

  it('pins getHistories window and pagination guidance in the shipped endpoint reference', () => {
    const content = read('skills/xyte-cli/references/endpoints.md');

    expect(content).toContain('31 days');
    expect(content).toContain('has_next_page');
    expect(content).toContain("set the next window's `to` to the current window's `from`");
    expect(content).toContain('(uuid, create_at)');
  });

  it('documents generic utility behavior for note write endpoints', () => {
    const docs = read('docs/ai-utility-preprocessing.md');
    const skill = read('skills/xyte-cli/references/ai-utility-preprocessing.md');
    const utilities = read('skills/xyte-cli/references/utilities.md');

    for (const content of [docs, skill, utilities]) {
      expect(content).toContain('organization.notes.createDeviceNote');
      expect(content).toContain('organization.notes.deleteDeviceNote');
      expect(content).toContain('call-loop');
    }
    expect(utilities).toContain('There is no dedicated bulk notes executor.');
  });

  it('surfaces note examples in top-level operator docs', () => {
    const readme = read('README.md');
    const commands = read('docs/commands.md');

    expect(readme).toContain('organization.notes.getDeviceNotes');
    expect(readme).toContain('organization.notes.createDeviceNote');
    expect(commands).toContain('organization.notes.getDeviceNotes');
    expect(commands).toContain('organization.notes.deleteDeviceNote');
  });
});

describe('maintenance schedule docs and skill guidance', () => {
  it('lists every catalog query field in the endpoint reference filter matrix', () => {
    const content = read('skills/xyte-cli/references/endpoints.md');

    for (const key of [
      'organization.maintenanceSchedules.getMaintenanceSchedules',
      'organization.incidents.getIncidents',
      'organization.spaces.getSpaces'
    ]) {
      const row = content.split('\n').find((line) => line.startsWith(`| \`${key}\` |`));
      expect(row, key).toBeDefined();
      for (const field of endpoints.find((item) => item.key === key)?.queryParams ?? []) {
        expect(row).toContain(`\`${field}\``);
      }
    }
  });

  it('documents all maintenance schedule keys and gates their writes behind approval', () => {
    const content = read('skills/xyte-cli/references/endpoints.md');
    const keys = endpoints.filter((item) => item.group === 'maintenanceSchedules').map((item) => item.key);

    expect(keys).toHaveLength(5);
    for (const key of keys) {
      expect(content).toContain(`- \`${key}\``);
    }
    const section = content.slice(content.indexOf('### `organization.maintenanceSchedules.*`'));
    expect(section).toContain('explicit user approval');
  });

  it('tells agents suppressed incidents are hidden unless include_suppressed is set', () => {
    for (const content of [read('skills/xyte-cli/SKILL.md'), read('skills/xyte-cli/references/endpoints.md')]) {
      expect(content).toContain('include_suppressed');
      expect(content).toContain('scheduled maintenance window are left out');
    }
  });
});
