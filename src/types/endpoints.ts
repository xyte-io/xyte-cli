export type EndpointNamespace = 'device' | 'organization' | 'partner';

export type EndpointBase = 'hub' | 'entry';

export type EndpointAuthScope = 'none' | 'device' | 'organization' | 'partner';

export type EndpointBodyType = 'none' | 'json' | 'multipart-form' | 'unknown';

export interface PublicEndpointSpec {
  key: string;
  namespace: EndpointNamespace;
  group: string;
  action: string;
  title: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  base: EndpointBase;
  pathTemplate: string;
  pathParams: string[];
  queryParams: string[];
  authScope: EndpointAuthScope;
  bodyType: EndpointBodyType;
  hasBody: boolean;
  sourceFile: string;
  bodyExample?: string;
  notes?: string[];
}

export interface EndpointCallArgs {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}
