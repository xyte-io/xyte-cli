import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function read(relPath: string): string {
  return readFileSync(resolve(__dirname, '..', relPath), 'utf8');
}

describe('update notifier agent guidance', () => {
  it('tells agents to relay update notices without upgrading automatically', () => {
    const skill = read('skills/xyte-cli/SKILL.md');

    expect(skill).toContain('A new version of xyte-cli is available');
    expect(skill).toContain('mention it once in the final user response');
    expect(skill).toContain('Do not run `xyte-cli upgrade` unless the user explicitly asks');
  });
});
