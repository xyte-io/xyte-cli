import { describe, expect, it } from 'vitest';

import { computeDelta, normalizeIncidents, resolveIncidentId, stableNormalize } from '../src/workflows/watch';

describe('stableNormalize', () => {
  it('sorts object keys deterministically', () => {
    const result = stableNormalize({ z: 1, a: 2, m: 3 });
    expect(Object.keys(result as Record<string, unknown>)).toEqual(['a', 'm', 'z']);
  });

  it('recursively normalizes nested objects', () => {
    const result = stableNormalize({ b: { z: 1, a: 2 }, a: 'top' });
    const outer = result as Record<string, unknown>;
    expect(Object.keys(outer)).toEqual(['a', 'b']);
    expect(Object.keys(outer.b as Record<string, unknown>)).toEqual(['a', 'z']);
  });

  it('normalizes arrays element-wise', () => {
    const result = stableNormalize([{ b: 1, a: 2 }]);
    const arr = result as unknown[];
    expect(Object.keys(arr[0] as Record<string, unknown>)).toEqual(['a', 'b']);
  });

  it('passes primitives through unchanged', () => {
    expect(stableNormalize(42)).toBe(42);
    expect(stableNormalize('hello')).toBe('hello');
    expect(stableNormalize(null)).toBe(null);
    expect(stableNormalize(undefined)).toBe(undefined);
  });
});

describe('resolveIncidentId', () => {
  it('uses id field when present', () => {
    expect(resolveIncidentId({ id: 'inc-1' }, '{}')).toBe('inc-1');
  });

  it('uses _id field as fallback', () => {
    expect(resolveIncidentId({ _id: 'mongo-1' }, '{}')).toBe('mongo-1');
  });

  it('uses incident_id field as fallback', () => {
    expect(resolveIncidentId({ incident_id: 'ext-1' }, '{}')).toBe('ext-1');
  });

  it('prefers id over _id and incident_id', () => {
    expect(resolveIncidentId({ id: 'a', _id: 'b', incident_id: 'c' }, '{}')).toBe('a');
  });

  it('returns anon: prefix when no id field exists', () => {
    const result = resolveIncidentId({ name: 'orphan' }, '{"name":"orphan"}');
    expect(result).toMatch(/^anon:[0-9a-f]{16}$/);
  });

  it('skips empty string id values', () => {
    const result = resolveIncidentId({ id: '', _id: '' }, '{"stable":"data"}');
    expect(result).toMatch(/^anon:/);
  });

  it('handles non-object input', () => {
    const result = resolveIncidentId('not-an-object', '"not-an-object"');
    expect(result).toMatch(/^anon:/);
  });
});

describe('normalizeIncidents', () => {
  it('normalizes and sorts by id', () => {
    const items = [
      { id: 'z-last', severity: 'high' },
      { id: 'a-first', severity: 'low' }
    ];
    const result = normalizeIncidents(items);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a-first');
    expect(result[1].id).toBe('z-last');
  });

  it('deduplicates by resolved id', () => {
    const items = [
      { id: 'dup', severity: 'high' },
      { id: 'dup', severity: 'low' }
    ];
    const result = normalizeIncidents(items);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('dup');
  });

  it('returns empty array for empty input', () => {
    expect(normalizeIncidents([])).toEqual([]);
  });

  it('assigns anon ids to items without id fields', () => {
    const result = normalizeIncidents([{ name: 'no-id' }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toMatch(/^anon:/);
  });
});

describe('computeDelta', () => {
  const normalize = (items: Record<string, unknown>[]) => normalizeIncidents(items);

  it('detects added items', () => {
    const previous = normalize([{ id: 'a' }]);
    const current = normalize([{ id: 'a' }, { id: 'b' }]);
    const delta = computeDelta(previous, current);

    expect(delta.added).toHaveLength(1);
    expect(delta.added[0].id).toBe('b');
    expect(delta.removed).toHaveLength(0);
    expect(delta.updated).toHaveLength(0);
  });

  it('detects removed items', () => {
    const previous = normalize([{ id: 'a' }, { id: 'b' }]);
    const current = normalize([{ id: 'a' }]);
    const delta = computeDelta(previous, current);

    expect(delta.removed).toHaveLength(1);
    expect(delta.removed[0].id).toBe('b');
    expect(delta.added).toHaveLength(0);
    expect(delta.updated).toHaveLength(0);
  });

  it('detects updated items', () => {
    const previous = normalize([{ id: 'a', status: 'open' }]);
    const current = normalize([{ id: 'a', status: 'closed' }]);
    const delta = computeDelta(previous, current);

    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0].id).toBe('a');
    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
  });

  it('returns empty delta for identical snapshots', () => {
    const items = normalize([{ id: 'a', status: 'open' }]);
    const delta = computeDelta(items, items);

    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
    expect(delta.updated).toHaveLength(0);
  });

  it('handles empty previous (all added)', () => {
    const current = normalize([{ id: 'a' }, { id: 'b' }]);
    const delta = computeDelta([], current);

    expect(delta.added).toHaveLength(2);
    expect(delta.removed).toHaveLength(0);
  });

  it('handles empty current (all removed)', () => {
    const previous = normalize([{ id: 'a' }, { id: 'b' }]);
    const delta = computeDelta(previous, []);

    expect(delta.removed).toHaveLength(2);
    expect(delta.added).toHaveLength(0);
  });

  it('detects simultaneous adds, removes, and updates', () => {
    const previous = normalize([
      { id: 'keep', status: 'open' },
      { id: 'change', status: 'active' },
      { id: 'gone', status: 'stale' }
    ]);
    const current = normalize([
      { id: 'keep', status: 'open' },
      { id: 'change', status: 'resolved' },
      { id: 'new', status: 'fresh' }
    ]);
    const delta = computeDelta(previous, current);

    expect(delta.added).toHaveLength(1);
    expect(delta.added[0].id).toBe('new');
    expect(delta.removed).toHaveLength(1);
    expect(delta.removed[0].id).toBe('gone');
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0].id).toBe('change');
  });
});
