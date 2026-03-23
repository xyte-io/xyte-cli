import { describe, expect, it } from 'vitest';

import { stringifyJsonOutput, writeJsonLine } from '../src/utils/json-output';

describe('stringifyJsonOutput', () => {
  it('returns pretty-printed JSON by default', () => {
    expect(stringifyJsonOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('returns compact JSON when compact option is true', () => {
    expect(stringifyJsonOutput({ a: 1 }, { compact: true })).toBe('{"a":1}');
  });

  it('handles circular references in safe mode', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = stringifyJsonOutput(obj);
    expect(result).toContain('[Circular]');
  });

  it('throws on circular references in strict mode', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => stringifyJsonOutput(obj, { strictJson: true })).toThrow();
  });

  it('converts bigint to string in safe mode', () => {
    const result = stringifyJsonOutput({ n: BigInt(42) });
    expect(result).toContain('"42"');
  });

  it('handles null and undefined values', () => {
    expect(stringifyJsonOutput(null)).toBe('null');
    expect(stringifyJsonOutput(undefined)).toBeUndefined();
  });

  it('handles arrays', () => {
    expect(stringifyJsonOutput([1, 2, 3], { compact: true })).toBe('[1,2,3]');
  });
});

describe('writeJsonLine', () => {
  it('writes JSON followed by newline', () => {
    const chunks: string[] = [];
    const stream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      }
    };
    writeJsonLine(stream, { a: 1 }, { compact: true });
    expect(chunks).toEqual(['{"a":1}\n']);
  });
});
