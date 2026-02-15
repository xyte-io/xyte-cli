import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createTuiLogger } from '../../src/tui/logger';

describe('tui logger', () => {
  it('writes JSON lines to file when enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-tui-logger-'));
    const filePath = join(dir, 'tui.log');

    const logger = createTuiLogger({
      enabled: true,
      path: filePath
    });
    logger.log('test.event', { value: 1 });
    logger.close();

    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    const start = JSON.parse(lines[0]) as { seq: number; event: string };
    const last = JSON.parse(lines[lines.length - 1]) as { seq: number; event: string; data: { value: number } };
    expect(start.seq).toBe(1);
    expect(last.event).toBe('test.event');
    expect(last.data.value).toBe(1);
    expect(last.seq).toBeGreaterThan(start.seq);

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no-op logger when disabled', () => {
    const logger = createTuiLogger({ enabled: false });
    expect(logger.enabled).toBe(false);
    logger.log('ignored');
    logger.close();
  });
});
