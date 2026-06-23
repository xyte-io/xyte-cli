import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const C2C_UNSUPPORTED_SENTENCE = 'Cloud-to-Cloud (C2C) claiming is not available via the public Xyte API today';
const END_CUSTOMER_PORTAL = 'End Customer Portal';
const NATIVE_KEY = 'organization.devices.claimDevice';
const EDGE_KEY = 'organization.edge.startClaim';
const EDGE_MODELS_KEY = 'organization.edges.getModels';
const DISAMBIGUATION_MARKER = 'Which claim path applies?';

function read(relPath: string): string {
  return readFileSync(resolve(__dirname, '..', relPath), 'utf8');
}

describe('claim-guidance surfaces', () => {
  const targets: Array<{ label: string; path: string }> = [
    { label: 'skills/xyte-cli/SKILL.md', path: 'skills/xyte-cli/SKILL.md' },
    { label: 'skills/xyte-cli/references/claim-playbook.md', path: 'skills/xyte-cli/references/claim-playbook.md' },
    { label: 'docs/claim-devices.md', path: 'docs/claim-devices.md' }
  ];

  for (const target of targets) {
    describe(target.label, () => {
      const content = read(target.path);

      it('mentions both the native and edge catalog keys', () => {
        expect(content).toContain(NATIVE_KEY);
        expect(content).toContain(EDGE_KEY);
      });

      it('states the verbatim C2C-unsupported sentence and routes to the End Customer Portal', () => {
        expect(content).toContain(C2C_UNSUPPORTED_SENTENCE);
        expect(content).toContain(END_CUSTOMER_PORTAL);
      });

      it('documents the mandatory disambiguation question', () => {
        expect(content).toMatch(/Native \/ direct/);
        expect(content).toMatch(/Edge/);
      });

      it('documents batch-owned edge connectivity checks', () => {
        expect(content).toContain('pre-claim');
        expect(content).toContain('ping-failed');
      });

      it('documents edge model discovery before non-heartbeat edge claims', () => {
        expect(content).toContain('xyte-cli edge models');
        expect(content).toContain('xyte-cli edge model');
        expect(content).toContain('parameters[].name');
        expect(content).toContain('custom_parameters');
      });

      it('documents the edge-specific hostname update path', () => {
        expect(content).toContain('edge update-hostname');
        expect(content).toContain('organization.devices.updateDevice');
        expect(content).toMatch(/preserves existing custom parameter/i);
      });

      it('documents true, false, blank, conflict, and resume retry semantics', () => {
        expect(content).toContain('skip_connectivity_check=true');
        expect(content).toContain('skip_connectivity_check=false');
        expect(content.toLowerCase()).toContain('blank');
        expect(content.toLowerCase()).toContain('conflict');
        expect(content.toLowerCase()).toContain('resume');
      });
    });
  }

  it('SKILL.md carries the disambiguation marker for ambiguous claim requests', () => {
    const skill = read('skills/xyte-cli/SKILL.md');
    expect(skill).toContain(DISAMBIGUATION_MARKER);
  });

  it('uses the generated edge-claim scaffold filenames on operator-facing guides', () => {
    const docs = read('docs/claim-devices.md');
    const playbook = read('skills/xyte-cli/references/claim-playbook.md');

    expect(docs).toContain('organization-edge-startclaim.csv');
    expect(docs).toContain('organization-edge-startclaim.rejected.csv');
    expect(playbook).toContain('organization-edge-startclaim.csv');
    expect(playbook).toContain('organization-edge-startclaim.rejected.csv');
  });

  it('separates edge batch stdout summary, report, and resume artifacts', () => {
    const docs = read('docs/claim-devices.md');
    const playbook = read('skills/xyte-cli/references/claim-playbook.md');

    for (const content of [docs, playbook]) {
      expect(content).toContain('xyte.edge.claim-batch.v1');
      expect(content).toContain('--report');
      expect(content).toContain('per-row audit NDJSON');
      expect(content).toContain('--resume-artifact');
      expect(content).toContain('resume state');
    }
    expect(playbook).not.toContain('batch summary written to `--report`');
  });

  it('documents resume limits and avoids stale mixed-proxy/timeout wording', () => {
    const skill = read('skills/xyte-cli/SKILL.md');
    const docs = read('docs/claim-devices.md');
    const playbook = read('skills/xyte-cli/references/claim-playbook.md');

    for (const content of [skill, docs, playbook]) {
      expect(content).toContain('does not checkpoint in-flight claim IDs');
      expect(content).not.toContain('claim_timeout');
      expect(content).not.toContain('not serialized across proxies');
    }
  });

  it('uses the real batch-flow input context key in SKILL.md', () => {
    const skill = read('skills/xyte-cli/SKILL.md');

    expect(skill).toContain('edge_claim_input_path');
    expect(skill).not.toContain('edge_claim_prepare_input');
  });

  it('documents the edge model discovery endpoint key in endpoint references', () => {
    const endpoints = read('skills/xyte-cli/references/endpoints.md');

    expect(endpoints).toContain(EDGE_MODELS_KEY);
    expect(endpoints).toContain('organization.edges.getModel');
  });
});
