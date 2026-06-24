import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

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
