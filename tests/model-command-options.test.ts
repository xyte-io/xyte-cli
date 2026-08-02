import { describe, expect, it } from 'vitest';

import {
  extractModelCommandOptionSet,
  matchModelCommandOption,
  type ModelCommandOptionSet
} from '../src/workflows/model-command-options';

function optionSet(options: Record<string, unknown>): ModelCommandOptionSet {
  const result = extractModelCommandOptionSet({
    name: 'input',
    type: 'select',
    typeName: 'staticListSingle',
    options
  });
  expect(result).toBeDefined();
  return result!;
}

describe('model command select options', () => {
  it('maps labels and equivalent scalar input to the exact model-defined value', () => {
    const result = optionSet({
      '33': { label: 'HDMI 1', order: 2, value: '33' },
      '35': { label: 'HDMI 2', order: 4, value: '35' }
    });

    expect(result.issues).toEqual([]);
    expect(matchModelCommandOption(result.options, 'HDMI 1')).toEqual({ status: 'matched', value: '33' });
    expect(matchModelCommandOption(result.options, '33')).toEqual({ status: 'matched', value: '33' });
    expect(matchModelCommandOption(result.options, 33)).toEqual({ status: 'matched', value: '33' });
  });

  it('supports either safely inferable primitive-map orientation', () => {
    const canonicalKey = optionSet({ '33': 'HDMI 1' });
    const labelKey = optionSet({ 'HDMI 1': '33' });

    expect(canonicalKey.issues).toEqual([]);
    expect(labelKey.issues).toEqual([]);
    expect(matchModelCommandOption(canonicalKey.options, 'HDMI 1')).toEqual({
      status: 'matched',
      value: '33'
    });
    expect(matchModelCommandOption(labelKey.options, 'HDMI 1')).toEqual({
      status: 'matched',
      value: '33'
    });
  });

  it('preserves a numeric model-defined value without loose numeric coercion', () => {
    const result = optionSet({ 'HDMI 1': 33 });

    expect(result.issues).toEqual([]);
    expect(matchModelCommandOption(result.options, 'HDMI 1')).toEqual({ status: 'matched', value: 33 });
    expect(matchModelCommandOption(result.options, '33')).toEqual({ status: 'matched', value: 33 });
    expect(matchModelCommandOption(result.options, '033')).toEqual({ status: 'unmatched' });
  });

  it('rejects primitive maps whose direction cannot be inferred safely', () => {
    expect(optionSet({ foo: 'bar' }).issues).not.toEqual([]);
    expect(optionSet({ '33': '35' }).issues).not.toEqual([]);
  });

  it('reports duplicate labels as ambiguous while exact canonical values still match', () => {
    const result = optionSet({
      '33': { label: 'Input', value: '33' },
      '35': { label: 'Input', value: '35' }
    });

    expect(matchModelCommandOption(result.options, 'Input')).toEqual({ status: 'ambiguous' });
    expect(matchModelCommandOption(result.options, '33')).toEqual({ status: 'matched', value: '33' });
  });

  it('rejects malformed explicit option values instead of falling back to the map key', () => {
    const result = optionSet({
      '33': { label: 'HDMI 1', value: { nested: 'invalid' } }
    });

    expect(result.options).toEqual([]);
    expect(result.issues).not.toEqual([]);
  });
});
