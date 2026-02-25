import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listBuiltInFlowDefinitions } from '../src/workflows/flow-catalog';

function normalizeRecipeLine(value: string): string {
  return value.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
}

function extractFlowSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const headingPattern = /^##\s+(flow\.[^\n]+)\n/gm;
  const headings: Array<{ flowId: string; headingIndex: number; bodyStartIndex: number }> = [];

  for (const match of markdown.matchAll(headingPattern)) {
    const flowId = match[1].trim();
    const headingIndex = match.index ?? 0;
    const bodyStartIndex = headingIndex + match[0].length;
    headings.push({ flowId, headingIndex, bodyStartIndex });
  }

  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i];
    const nextHeadingStart = headings[i + 1]?.headingIndex ?? markdown.length;
    sections[current.flowId] = markdown.slice(current.bodyStartIndex, nextHeadingStart);
  }

  return sections;
}

function extractRecipeCommands(section: string): string[] {
  const blockMatch = section.match(/```bash\n([\s\S]*?)\n```/m);
  if (!blockMatch) {
    return [];
  }
  return blockMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('flow catalog recipe parity', () => {
  it('keeps built-in recipe command lists aligned with docs/flows/agent-ops.md', () => {
    const markdown = readFileSync(resolve(__dirname, '../docs/flows/agent-ops.md'), 'utf8');
    const sections = extractFlowSections(markdown);

    for (const flow of listBuiltInFlowDefinitions()) {
      const section = sections[flow.id];
      expect(section, `Missing section for ${flow.id}`).toBeDefined();
      const docsCommands = extractRecipeCommands(section);
      expect(docsCommands.length, `Missing recipe commands for ${flow.id}`).toBeGreaterThan(0);

      expect(flow.recipeCommands.map(normalizeRecipeLine)).toEqual(docsCommands.map(normalizeRecipeLine));
    }
  });
});
