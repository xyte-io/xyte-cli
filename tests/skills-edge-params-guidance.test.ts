import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function read(relPath: string): string {
  return readFileSync(resolve(__dirname, '..', relPath), 'utf8');
}

describe('edge custom params docs and skill guidance', () => {
  it('documents the dedicated utility action and execution support', () => {
    const docs = read('docs/ai-utility-preprocessing.md');
    const skill = read('skills/xyte-cli/references/ai-utility-preprocessing.md');
    const utilities = read('skills/xyte-cli/references/utilities.md');

    for (const content of [docs, skill, utilities]) {
      expect(content).toContain('edge.params.update');
      expect(content).toContain('edge update-params-batch');
      expect(content).toContain('device_id,set_json,expected_model_id');
      expect(content).toContain('masked_password_requires_value');
      expect(content).toContain('unsupported_current_parameter');
      expect(content).toContain('missing_required_parameter');
      expect(content).toContain('duplicate_device_id');
    }
    expect(docs).toContain('edge.params-update-batch');
    expect(skill).toContain('edge.params-update-batch');
  });

  it('documents model endpoints and complete replacement safety in endpoint references', () => {
    const endpoints = read('skills/xyte-cli/references/endpoints.md');
    const commands = read('docs/commands.md');

    for (const content of [endpoints, commands]) {
      expect(content).toContain('organization.models.getModels');
      expect(content).toContain('organization.models.getModel');
      expect(content).toContain('complete replacement');
      expect(content).toContain('parameters[].name');
      expect(content).toContain('*****');
    }
  });

  it('documents getDevices pagination in general operator docs', () => {
    const readme = read('README.md');
    const commands = read('docs/commands.md');

    for (const content of [readme, commands]) {
      expect(content).toContain('organization.devices.getDevices');
      expect(content).toContain('"page":1,"per_page":100');
      expect(content).toContain('has_next_page=false');
    }
  });

  it('surfaces the GH Pages guide and reference pages', () => {
    const guideIndex = read('docs/guides/index.html');
    const landing = read('docs/index.html');
    const guide = read('docs/guides/edge-custom-params.html');
    const flows = read('docs/reference/built-in-flows.html');

    for (const content of [guideIndex, landing]) {
      expect(content).toContain('edge-custom-params.html');
    }
    expect(guide).toContain('xyte-cli edge update-params');
    expect(guide).toContain('xyte-cli edge update-params-batch');
    expect(guide).toContain('Unsupported current parameter');
    expect(guide).toContain('Missing required parameter');
    expect(guide).toContain('Duplicate device row');
    expect(read('docs/reference/commands.html')).toContain('edge update-params');
    expect(flows).toContain('flow.edge-params-update-batch');
  });

  it('ships Edge command schemas in Markdown docs, GH Pages, and skills', () => {
    const utilityDocs = read('docs/ai-utility-preprocessing.md');
    const utilitySkill = read('skills/xyte-cli/references/ai-utility-preprocessing.md');
    const schemaContracts = read('docs/reference/schema-contracts.html');

    for (const schema of [
      'edge-claim-batch.v1.schema.json',
      'edge-models-list.v1.schema.json',
      'edge-models-describe.v1.schema.json',
      'edge-params-update.v1.schema.json',
      'edge-params-update-batch.v1.schema.json'
    ]) {
      expect(utilityDocs).toContain(schema);
      expect(utilitySkill).toContain(schema);
      expect(schemaContracts).toContain(schema);
      expect(read(`docs/schemas/${schema}`)).toContain('xyte.edge.');
      expect(read(`skills/xyte-cli/schemas/${schema}`)).toEqual(read(`docs/schemas/${schema}`));
    }
  });
});
