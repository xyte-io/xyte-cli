import { describe, expect, it } from 'vitest';

import { getEndpoint, listEndpointKeys, listEndpoints } from '../src/client/catalog';

describe('listEndpoints', () => {
  it('returns all endpoints when no namespace is given', () => {
    const all = listEndpoints();
    expect(all.length).toBeGreaterThan(0);
  });

  it('filters by namespace', () => {
    const all = listEndpoints();
    const namespaces = [...new Set(all.map((e) => e.namespace))];
    expect(namespaces.length).toBeGreaterThan(0);
    const filtered = listEndpoints(namespaces[0]);
    expect(filtered.every((e) => e.namespace === namespaces[0])).toBe(true);
    expect(filtered.length).toBeLessThanOrEqual(all.length);
  });

  it('returns a copy, not the original array', () => {
    const a = listEndpoints();
    const b = listEndpoints();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('getEndpoint', () => {
  it('returns an endpoint by key', () => {
    const keys = listEndpointKeys();
    expect(keys.length).toBeGreaterThan(0);
    const endpoint = getEndpoint(keys[0]);
    expect(endpoint.key).toBe(keys[0]);
  });

  it('throws for unknown key', () => {
    expect(() => getEndpoint('__nonexistent__')).toThrow('Unknown endpoint key');
  });
});

describe('listEndpointKeys', () => {
  it('returns an array of strings', () => {
    const keys = listEndpointKeys();
    expect(Array.isArray(keys)).toBe(true);
    keys.forEach((k) => expect(typeof k).toBe('string'));
  });
});
