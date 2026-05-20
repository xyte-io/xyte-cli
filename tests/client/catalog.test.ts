import { describe, expect, it } from 'vitest';

import { getEndpoint, listEndpointKeys, listEndpoints } from '../../src/client/catalog';

describe('listEndpoints', () => {
  it('returns all endpoints when no namespace given', () => {
    const all = listEndpoints();
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toHaveProperty('key');
    expect(all[0]).toHaveProperty('namespace');
  });

  it('filters by namespace', () => {
    const orgEndpoints = listEndpoints('organization');
    expect(orgEndpoints.length).toBeGreaterThan(0);
    for (const e of orgEndpoints) {
      expect(e.namespace).toBe('organization');
    }
  });

  it('returns empty array for unknown namespace', () => {
    expect(listEndpoints('nonexistent' as never)).toEqual([]);
  });
});

describe('getEndpoint', () => {
  it('returns endpoint for a known key', () => {
    const keys = listEndpointKeys();
    const endpoint = getEndpoint(keys[0]);
    expect(endpoint.key).toBe(keys[0]);
  });

  it('throws for an unknown key', () => {
    expect(() => getEndpoint('does.not.exist')).toThrow('Unknown endpoint key');
  });
});

describe('listEndpointKeys', () => {
  it('returns an array of strings', () => {
    const keys = listEndpointKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(typeof key).toBe('string');
    }
  });
});
