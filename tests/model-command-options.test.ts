import { describe, expect, it } from 'vitest';

import {
  extractModelCommandOptionSet,
  matchModelCommandOption,
  MODEL_COMMAND_PATH_OPTIONS_ISSUE,
  type ModelCommandOptionSet
} from '../src/workflows/model-command-options';

function optionSet(options: Record<string, unknown>, type = 'select'): ModelCommandOptionSet {
  const result = extractModelCommandOptionSet({
    name: 'input',
    type,
    typeName: type === 'multiselect' ? 'staticListMulti' : 'staticListSingle',
    options
  });
  expect(result).toBeDefined();
  return result!;
}

describe('model command field options', () => {
  it('maps labels and equivalent scalar input to the exact model-defined value', () => {
    const result = optionSet({
      '33': { label: 'HDMI 1', order: 2, value: '33' },
      '35': { label: 'HDMI 2', order: 4, value: '35' }
    });

    expect(result.issues).toEqual([]);
    expect(result.cardinality).toBe('single');
    expect(matchModelCommandOption(result, 'HDMI 1')).toEqual({ status: 'matched', value: '33' });
    expect(matchModelCommandOption(result, '33')).toEqual({ status: 'matched', value: '33' });
    expect(matchModelCommandOption(result, 33)).toEqual({ status: 'matched', value: '33' });
  });

  it('supports either safely inferable primitive-map orientation', () => {
    const canonicalKey = optionSet({ '33': 'HDMI 1' });
    const labelKey = optionSet({ 'HDMI 1': '33' });

    expect(canonicalKey.issues).toEqual([]);
    expect(labelKey.issues).toEqual([]);
    expect(matchModelCommandOption(canonicalKey, 'HDMI 1')).toEqual({
      status: 'matched',
      value: '33'
    });
    expect(matchModelCommandOption(labelKey, 'HDMI 1')).toEqual({
      status: 'matched',
      value: '33'
    });
  });

  it('extracts options from multi-select command fields', () => {
    const result = optionSet(
      {
        '33': { label: 'HDMI 1', value: '33' },
        '35': { label: 'HDMI 2', value: '35' }
      },
      'multiselect'
    );

    expect(result.issues).toEqual([]);
    expect(result.cardinality).toBe('multiple');
    expect(matchModelCommandOption(result, ['HDMI 1', '35'])).toEqual({
      status: 'matched',
      value: ['33', '35']
    });
  });

  it('maps every array entry and preserves exact model-defined value types', () => {
    const result = optionSet(
      {
        enabled: { label: 'Enabled', value: true },
        disabled: { label: 'Disabled', value: false }
      },
      'multiselect'
    );

    expect(matchModelCommandOption(result, ['Enabled', false])).toEqual({
      status: 'matched',
      value: [true, false]
    });
    expect(matchModelCommandOption(result, [])).toEqual({ status: 'matched', value: [] });
  });

  it('rejects an array when any option is unknown or ambiguous', () => {
    const result = optionSet(
      {
        '33': { label: 'Input', value: '33' },
        '35': { label: 'Input', value: '35' }
      },
      'multiselect'
    );

    expect(matchModelCommandOption(result, ['33', 'missing'])).toEqual({ status: 'unmatched' });
    expect(matchModelCommandOption(result, ['33', 'Input'])).toEqual({ status: 'ambiguous' });
  });

  it('rejects the wrong scalar or array shape for the field cardinality', () => {
    const single = optionSet({ a: { label: 'A', value: 'a' } });
    const multiple = optionSet({ a: { label: 'A', value: 'a' } }, 'multiselect');

    expect(matchModelCommandOption(single, ['A'])).toEqual({ status: 'invalid-cardinality' });
    expect(matchModelCommandOption(multiple, 'A')).toEqual({ status: 'invalid-cardinality' });
  });

  it('fails closed when option cardinality cannot be inferred', () => {
    const result = extractModelCommandOptionSet({
      name: 'mode',
      type: 'string',
      options: [{ label: 'Automatic', value: 'auto' }]
    });

    expect(result?.cardinality).toBe('unknown');
    expect(result?.options).toEqual([{ label: 'Automatic', value: 'auto' }]);
    expect(result?.issues).not.toEqual([]);
  });

  it('fails closed when type and typeName disagree about cardinality', () => {
    const result = extractModelCommandOptionSet({
      name: 'mode',
      type: 'select',
      typeName: 'staticListMulti',
      options: [{ label: 'Automatic', value: 'auto' }]
    });

    expect(result?.cardinality).toBe('unknown');
    expect(result?.issues).not.toEqual([]);
  });

  it('marks path-backed options as unresolved instead of accepting unchecked values', () => {
    const result = extractModelCommandOptionSet({
      name: 'input',
      type: 'multiselect',
      typeName: 'dynamicListMulti',
      path: 'details.available_inputs'
    });

    expect(result?.cardinality).toBe('multiple');
    expect(result?.options).toEqual([]);
    expect(result?.issues).toContain(MODEL_COMMAND_PATH_OPTIONS_ISSUE);
  });

  it('fails closed when a choice field omits both embedded options and a path', () => {
    const result = extractModelCommandOptionSet({ name: 'mode', type: 'multiselect' });

    expect(result?.cardinality).toBe('multiple');
    expect(result?.options).toEqual([]);
    expect(result?.issues).toContain('option-backed field does not include model-defined choices');
  });

  it('rejects malformed option containers and preserves empty option sets for fail-closed validation', () => {
    const malformed = extractModelCommandOptionSet({
      name: 'mode',
      type: 'select',
      typeName: 'staticListSingle',
      options: 'not-an-option-container'
    });
    const empty = extractModelCommandOptionSet({
      name: 'mode',
      type: 'select',
      typeName: 'staticListSingle',
      options: {}
    });

    expect(malformed?.options).toEqual([]);
    expect(malformed?.issues).toContain('options must be an array or object');
    expect(empty).toEqual({ cardinality: 'single', options: [], issues: [] });
  });

  it('fails closed when typeName is unknown or type is missing', () => {
    const unknownTypeName = extractModelCommandOptionSet({
      name: 'mode',
      type: 'select',
      typeName: 'surpriseList',
      options: [{ label: 'Automatic', value: 'auto' }]
    });
    const missingType = extractModelCommandOptionSet({
      name: 'mode',
      typeName: 'staticListSingle',
      options: [{ label: 'Automatic', value: 'auto' }]
    });

    expect(unknownTypeName?.cardinality).toBe('unknown');
    expect(unknownTypeName?.issues).not.toEqual([]);
    expect(missingType?.cardinality).toBe('unknown');
    expect(missingType?.issues).not.toEqual([]);
  });

  it('fails closed when typeName or path metadata has the wrong shape', () => {
    const malformedTypeName = extractModelCommandOptionSet({
      name: 'mode',
      type: 'select',
      typeName: 123,
      options: [{ label: 'Automatic', value: 'auto' }]
    });
    const malformedPath = extractModelCommandOptionSet({
      name: 'mode',
      type: 'select',
      typeName: 'staticListSingle',
      path: 123,
      options: [{ label: 'Automatic', value: 'auto' }]
    });

    expect(malformedTypeName?.issues).toContain('field typeName must be a non-empty string when provided');
    expect(malformedPath?.issues).toContain('field path must be a non-empty string when provided');
  });

  it('fails closed when dynamic option metadata also embeds static choices', () => {
    const result = extractModelCommandOptionSet({
      name: 'mode',
      type: 'select',
      typeName: 'dynamicListSingle',
      path: 'details.available_modes',
      options: [{ label: 'Automatic', value: 'auto' }]
    });

    expect(result?.cardinality).toBe('single');
    expect(result?.issues).toContain('dynamic command options cannot also embed static options');
    expect(result?.issues).toContain(MODEL_COMMAND_PATH_OPTIONS_ISSUE);
  });

  it.each([
    {
      label: 'static metadata also declares a path',
      field: {
        name: 'mode',
        type: 'select',
        typeName: 'staticListSingle',
        path: 'details.available_modes',
        options: [{ label: 'Automatic', value: 'auto' }]
      },
      expectedIssue: 'static command options cannot use a dynamic path'
    },
    {
      label: 'dynamic metadata omits its path',
      field: {
        name: 'mode',
        type: 'select',
        typeName: 'dynamicListSingle'
      },
      expectedIssue: 'dynamic command options require a path'
    }
  ])('fails closed when $label', ({ field, expectedIssue }) => {
    const result = extractModelCommandOptionSet(field);

    expect(result).toBeDefined();
    expect(result?.issues).toContain(expectedIssue);
  });

  it('supports legacy type-only option metadata while ignoring ordinary non-choice fields', () => {
    const legacy = extractModelCommandOptionSet({
      name: 'mode',
      type: 'select',
      options: [{ label: 'Automatic', value: 'auto' }]
    });

    expect(legacy).toEqual({
      cardinality: 'single',
      options: [{ label: 'Automatic', value: 'auto' }],
      issues: []
    });
    expect(extractModelCommandOptionSet({ name: 'delay', type: 'number' })).toBeUndefined();
  });

  it('preserves a numeric model-defined value without loose numeric coercion', () => {
    const result = optionSet({ 'HDMI 1': 33 });

    expect(result.issues).toEqual([]);
    expect(matchModelCommandOption(result, 'HDMI 1')).toEqual({ status: 'matched', value: 33 });
    expect(matchModelCommandOption(result, '33')).toEqual({ status: 'matched', value: 33 });
    expect(matchModelCommandOption(result, '033')).toEqual({ status: 'unmatched' });
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

    expect(matchModelCommandOption(result, 'Input')).toEqual({ status: 'ambiguous' });
    expect(matchModelCommandOption(result, '33')).toEqual({ status: 'matched', value: '33' });
  });

  it('rejects malformed explicit option values instead of falling back to the map key', () => {
    const result = optionSet({
      '33': { label: 'HDMI 1', value: { nested: 'invalid' } }
    });

    expect(result.options).toEqual([]);
    expect(result.issues).not.toEqual([]);
  });

  it('rejects null and empty canonical option values', () => {
    const result = optionSet({
      '': { label: 'Fallback empty' },
      empty: { label: 'Empty', value: '' },
      blank: { label: 'Blank', value: '   ' },
      missing: { label: 'Missing', value: null }
    });

    expect(result.options).toEqual([]);
    expect(result.issues).toHaveLength(4);
  });
});
