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

      it('documents Edge model discovery, optional mac/sn, and claimed-device params updates', () => {
        expect(content).toContain('edge models');
        expect(content).toContain('mac');
        expect(content).toContain('sn');
        expect(content).toContain('edge update-params');
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
      expect(content).toContain('edge-claim-batch.v1.schema.json');
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

  it('documents Edge claim batch schema on GH Pages and installed skill index', () => {
    const commandReference = read('docs/reference/commands.html');
    const schemaReference = read('docs/reference/schema-contracts.html');
    const guide = read('docs/guides/edge-claim.html');
    const skill = read('skills/xyte-cli/SKILL.md');

    expect(commandReference).toContain('xyte.edge.claim-batch.v1');
    expect(commandReference).not.toContain('edge claim-batch</td><td>Plans or runs an Edge claim batch from prepared rows.</td><td>NDJSON report and summary.</td><td>Writes report and resume artifact.</td><td>Use plan in scheduled jobs; run apply only from an approved job.</td><td><code>xyte.utility.batch.v1</code>');
    expect(schemaReference).toContain('edge-claim-batch.v1.schema.json');
    expect(schemaReference).toContain('xyte.edge.claim-batch.v1');
    expect(guide).toContain('MAC and serial are optional');
    expect(skill).toContain('edge claim batch: `xyte.edge.claim-batch.v1`');
    expect(skill).toContain('schemas/edge-claim-batch.v1.schema.json');
    expect(read('skills/xyte-cli/schemas/edge-claim-batch.v1.schema.json')).toEqual(
      read('docs/schemas/edge-claim-batch.v1.schema.json')
    );
  });
});
