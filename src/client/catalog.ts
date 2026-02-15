import rawEndpoints from '../spec/public-endpoints.json';
import type { EndpointNamespace, PublicEndpointSpec } from '../types/endpoints';

const endpoints = rawEndpoints as PublicEndpointSpec[];
const endpointMap = new Map(endpoints.map((endpoint) => [endpoint.key, endpoint]));

export function listEndpoints(namespace?: EndpointNamespace): PublicEndpointSpec[] {
  if (!namespace) {
    return endpoints.slice();
  }
  return endpoints.filter((endpoint) => endpoint.namespace === namespace);
}

export function getEndpoint(key: string): PublicEndpointSpec {
  const endpoint = endpointMap.get(key);
  if (!endpoint) {
    throw new Error(`Unknown endpoint key: ${key}`);
  }
  return endpoint;
}

export function hasEndpoint(key: string): boolean {
  return endpointMap.has(key);
}

export function listEndpointKeys(): string[] {
  return endpoints.map((endpoint) => endpoint.key);
}
