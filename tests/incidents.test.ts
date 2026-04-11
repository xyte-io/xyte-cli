import { describe, expect, it } from 'vitest';

import { extractIncidentsArray } from '../src/utils/incidents';

describe('extractIncidentsArray', () => {
  it('returns empty array for nullish input', () => {
    expect(extractIncidentsArray(null)).toEqual([]);
    expect(extractIncidentsArray(undefined)).toEqual([]);
  });

  it('extracts from top-level incidents key', () => {
    expect(extractIncidentsArray({ incidents: [{ id: 'i1' }] })).toEqual([{ id: 'i1' }]);
  });

  it('extracts from top-level data key', () => {
    expect(extractIncidentsArray({ data: [{ id: 'i2' }] })).toEqual([{ id: 'i2' }]);
  });

  it('extracts from top-level items key', () => {
    expect(extractIncidentsArray({ items: [{ id: 'i3' }] })).toEqual([{ id: 'i3' }]);
  });

  it('extracts from nested payload.incidents', () => {
    const value = { payload: { incidents: [{ id: 'i4' }] } };
    expect(extractIncidentsArray(value)).toEqual([{ id: 'i4' }]);
  });

  it('extracts from nested result.data', () => {
    const value = { result: { data: [{ id: 'i5' }] } };
    expect(extractIncidentsArray(value)).toEqual([{ id: 'i5' }]);
  });

  it('prefers top-level over nested wrapper', () => {
    const value = { incidents: [{ id: 'top' }], payload: { incidents: [{ id: 'nested' }] } };
    expect(extractIncidentsArray(value)).toEqual([{ id: 'top' }]);
  });

  it('returns empty array when no incidents found', () => {
    expect(extractIncidentsArray({ other: 'value' })).toEqual([]);
    expect(extractIncidentsArray([])).toEqual([]);
    expect(extractIncidentsArray('string')).toEqual([]);
  });
});
