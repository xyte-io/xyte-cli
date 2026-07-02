import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ASSET_KEYS = [
  'organization.assets.getAssets',
  'organization.assets.getAsset',
  'organization.assets.createAsset',
  'organization.assets.updateAsset',
  'organization.assets.deleteAsset'
];

function read(relPath: string): string {
  return readFileSync(resolve(__dirname, '..', relPath), 'utf8');
}

describe('assets endpoint docs and skill guidance', () => {
  it('documents all asset endpoint keys in the shipped endpoint reference', () => {
    const content = read('skills/xyte-cli/references/endpoints.md');

    for (const key of ASSET_KEYS) {
      expect(content).toContain(key);
    }
    expect(content).toContain('explicit user approval');
    expect(content).toContain('entity-label');
  });

  it('documents generic utility behavior for asset write endpoints', () => {
    const docs = read('docs/ai-utility-preprocessing.md');
    const skill = read('skills/xyte-cli/references/ai-utility-preprocessing.md');
    const utilities = read('skills/xyte-cli/references/utilities.md');

    for (const content of [docs, skill, utilities]) {
      expect(content).toContain('organization.assets.createAsset');
      expect(content).toContain('organization.assets.deleteAsset');
      expect(content).toContain('call-loop');
    }
    expect(utilities).toContain('There is no dedicated bulk assets executor.');
  });

  it('surfaces asset examples in top-level operator docs', () => {
    const readme = read('README.md');
    const commands = read('docs/commands.md');

    expect(readme).toContain('organization.assets.getAssets');
    expect(readme).toContain('organization.assets.createAsset');
    expect(commands).toContain('organization.assets.getAssets');
    expect(commands).toContain('organization.assets.deleteAsset');
  });
});
