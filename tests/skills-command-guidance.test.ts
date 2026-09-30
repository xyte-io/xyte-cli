import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SEND_COMMAND_ENDPOINT = 'organization.commands.sendCommand';
const SURFACES = [
  'skills/xyte-cli/SKILL.md',
  'skills/xyte-cli/references/endpoints.md',
  'skills/xyte-cli/references/flow-recipes.md'
];

function read(relPath: string): string {
  return readFileSync(resolve(__dirname, '..', relPath), 'utf8');
}

function fencedShellCommands(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/^```[^\r\n]*\r?\n([\s\S]*?)^```[ \t]*$/gm)].map((match) => match[1]);
  const commands: string[] = [];

  for (const block of blocks) {
    let command = '';
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || (line.startsWith('#') && !command)) {
        continue;
      }

      const continues = /\\\s*$/.test(line);
      const fragment = line.replace(/\\\s*$/, '').trim();
      command = command ? `${command} ${fragment}` : fragment;

      if (!continues) {
        commands.push(command);
        command = '';
      }
    }
    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

function parseSingleQuotedBody(command: string, surface: string): Record<string, unknown> {
  const bodyMatches = [...command.matchAll(/(?:^|\s)--body-json(?:=|\s+)'([^']*)'(?=\s|$)/g)];
  if (bodyMatches.length !== 1) {
    throw new Error(`${surface}: sendCommand example must contain exactly one single-quoted --body-json value`);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyMatches[0][1]);
  } catch (error) {
    throw new Error(`${surface}: sendCommand --body-json must contain valid JSON`, { cause: error });
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${surface}: sendCommand --body-json must contain a JSON object`);
  }
  return body as Record<string, unknown>;
}

describe('shipped send-command guidance', () => {
  for (const surface of SURFACES) {
    it(`${surface} uses the command request contract in every raw example`, () => {
      const invocations = fencedShellCommands(read(surface)).filter(
        (command) =>
          new RegExp(
            `(?:^|\\s)xyte-cli\\s+api\\s+call\\s+${SEND_COMMAND_ENDPOINT.replaceAll('.', '\\.')}(?:\\s|$)`
          ).test(command) && /(?:^|\s)--body-json(?:=|\s)/.test(command)
      );

      expect(invocations.length, `${surface} must contain a raw sendCommand example with --body-json`).toBeGreaterThan(
        0
      );

      for (const invocation of invocations) {
        const body = parseSingleQuotedBody(invocation, surface);
        const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
        const selectors = ['command', 'friendly_name'].filter(hasOwn);

        expect(selectors, `${surface}: sendCommand body must use exactly one supported selector`).toHaveLength(1);
        const selectorValue = body[selectors[0]];
        expect(
          typeof selectorValue === 'string' && selectorValue.trim().length > 0,
          `${surface}: sendCommand selector must be a non-empty string`
        ).toBe(true);
        expect(hasOwn('name'), `${surface}: name is model metadata, not a send request field`).toBe(false);
        expect(hasOwn('params'), `${surface}: params belongs to command responses, not send requests`).toBe(false);

        if (hasOwn('extra_params')) {
          expect(
            body.extra_params !== null && typeof body.extra_params === 'object' && !Array.isArray(body.extra_params),
            `${surface}: extra_params must be a JSON object`
          ).toBe(true);
        }
      }
    });
  }
});
