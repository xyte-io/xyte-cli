import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const C2C_UNSUPPORTED_SENTENCE = 'Cloud-to-Cloud (C2C) claiming is not available via the public Xyte API today';
const END_CUSTOMER_PORTAL = 'End Customer Portal';
const NATIVE_KEY = 'organization.devices.claimDevice';
const EDGE_KEY = 'organization.edge.startClaim';
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

  it('uses the real batch-flow input context key in SKILL.md', () => {
    const skill = read('skills/xyte-cli/SKILL.md');

    expect(skill).toContain('edge_claim_input_path');
    expect(skill).not.toContain('edge_claim_prepare_input');
  });
});
