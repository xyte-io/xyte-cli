import { describe, expect, it } from 'vitest';

import { safeInspect, safePreviewLines, safeSearchText } from '../../src/tui/serialize';

describe('safe serializer', () => {
  it('handles circular structures without throwing', () => {
    const value: any = { id: 'a' };
    value.self = value;

    const inspected = safeInspect(value);
    expect(inspected.text).toContain('[Circular]');
  });

  it('truncates deep and large payloads deterministically', () => {
    const deep: any = { level: 0 };
    let cursor = deep;
    for (let index = 1; index <= 20; index += 1) {
      cursor.next = { level: index };
      cursor = cursor.next;
    }
    deep.items = Array.from({ length: 300 }, (_, index) => ({ index, value: `value-${index}` }));

    const inspected = safeInspect(deep, { maxDepth: 4, maxArrayItems: 10, maxOutputChars: 2_000 });
    expect(inspected.truncated).toBe(true);
    expect(inspected.text).toContain('[DepthLimit]');
    expect(inspected.text).toContain('[Truncated');
  });

  it('produces safe lowercase search text for cyclic payloads', () => {
    const value: any = { name: 'Panel-Alpha' };
    value.loop = value;

    const text = safeSearchText(value);
    expect(text).toContain('panel-alpha');
    expect(text).toContain('[circular]');
  });

  it('adds stability banner when preview is truncated', () => {
    const huge = {
      id: 'preview-1',
      name: 'Device',
      status: 'online',
      data: Array.from({ length: 200 }, (_, index) => ({ index, payload: `x`.repeat(80) }))
    };

    const preview = safePreviewLines(huge, { maxOutputChars: 500, maxArrayItems: 10 });
    expect(preview.truncated).toBe(true);
    expect(preview.lines[0]).toBe('Preview truncated for stability.');
  });
});
