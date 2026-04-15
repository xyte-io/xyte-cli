import { describe, expect, it, vi } from 'vitest';

import { buildInstallDoctorReport } from '../src/workflows/install-doctor';

describe('install doctor', () => {
  it('accepts the Windows npm shim when it resolves to the installed package entrypoint', () => {
    const prefixDir = 'C:\\Users\\runner\\AppData\\Local\\Temp\\xyte-cli-pack-install\\npm-prefix';
    const expectedPath = `${prefixDir}\\node_modules\\@xyteai\\cli\\dist\\bin\\xyte-cli.js`;
    const commandPath = `${prefixDir}\\xyte-cli.cmd`;

    const report = buildInstallDoctorReport(expectedPath, {
      platform: 'win32',
      commandPathResolver: vi.fn(() => commandPath),
      realPathResolver: vi.fn((value: string) => {
        if (value === commandPath) {
          return commandPath;
        }
        if (value === expectedPath) {
          return expectedPath;
        }
        if (value === `${prefixDir}\\node_modules\\@xyteai\\cli\\dist\\bin\\xyte-cli.js`) {
          return expectedPath;
        }
        throw new Error(`Unexpected realpath lookup: ${value}`);
      })
    });

    expect(report.status).toBe('ok');
    expect(report.sameTarget).toBe(true);
    expect(report.commandPath).toBe(commandPath);
    expect(report.expectedPath).toBe(expectedPath);
  });

  it('reports mismatch when the Windows shim does not belong to the installed package', () => {
    const expectedPath = 'C:\\expected\\node_modules\\@xyteai\\cli\\dist\\bin\\xyte-cli.js';
    const commandPath = 'C:\\other-prefix\\xyte-cli.cmd';

    const report = buildInstallDoctorReport(expectedPath, {
      platform: 'win32',
      commandPathResolver: vi.fn(() => commandPath),
      realPathResolver: vi.fn((value: string) => {
        if (value === commandPath) {
          return commandPath;
        }
        if (value === expectedPath) {
          return expectedPath;
        }
        throw new Error(`Unexpected realpath lookup: ${value}`);
      })
    });

    expect(report.status).toBe('mismatch');
    expect(report.sameTarget).toBe(false);
  });
});
