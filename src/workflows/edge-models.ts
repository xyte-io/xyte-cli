import type { XyteClient } from '../types/client';

export interface RunEdgeModelsListArgs {
  client: XyteClient;
  tenantId: string;
  search?: string;
  page?: number;
  perPage?: number;
}

export interface EdgeModelsListQuery extends Record<string, string | number | boolean | undefined> {
  edge_only: true;
  search?: string;
  page?: number;
  per_page?: number;
}

export interface RunEdgeModelDescribeArgs {
  client: XyteClient;
  tenantId: string;
  modelId: string;
}

export function buildEdgeModelsListQuery(args: Omit<RunEdgeModelsListArgs, 'client' | 'tenantId'>): EdgeModelsListQuery {
  const query: EdgeModelsListQuery = {
    edge_only: true
  };
  if (args.search?.trim()) query.search = args.search.trim();
  if (args.page !== undefined) query.page = args.page;
  if (args.perPage !== undefined) query.per_page = args.perPage;
  return query;
}

export async function runEdgeModelsList(args: RunEdgeModelsListArgs): Promise<unknown> {
  const query = buildEdgeModelsListQuery(args);
  const response = await args.client.callWithMeta('organization.models.getModels', {
    tenantId: args.tenantId,
    query
  });
  return response.data;
}

export async function runEdgeModelDescribe(args: RunEdgeModelDescribeArgs): Promise<unknown> {
  const response = await args.client.callWithMeta('organization.models.getModel', {
    tenantId: args.tenantId,
    path: { id: args.modelId }
  });
  return response.data;
}
