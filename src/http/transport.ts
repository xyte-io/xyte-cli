import { setTimeout as delay } from 'node:timers/promises';

import { XyteHttpError } from './errors';
import { getLogger } from '../observability/logger';
import { withSpan } from '../observability/tracing';
import { errorMessage } from '../utils/error-format';

interface TransportOptions {
  timeoutMs?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
}

interface TransportRequest {
  requestId?: string;
  endpointKey?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  idempotent?: boolean;
  timeoutMs?: number;
}

interface TransportMeta {
  durationMs: number;
  attempts: number;
  retryCount: number;
}

interface TransportResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  meta: TransportMeta;
}

function toLowerCaseMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function summarizeHttpErrorDetails(details: unknown): string | undefined {
  if (typeof details === 'string') {
    const value = details.trim();
    return value || undefined;
  }

  if (!details || typeof details !== 'object') {
    return undefined;
  }

  const record = details as Record<string, unknown>;
  const directKeys = ['error_description', 'error', 'message', 'detail', 'title'];
  for (const key of directKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  for (const key of directKeys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === 'string' && entry.trim());
      if (typeof first === 'string' && first.trim()) {
        return first.trim();
      }
    }
  }

  return undefined;
}

function buildHttpErrorMessage(status: number, statusText: string, details: unknown): string {
  const base = `HTTP ${status} ${statusText}`;
  const summary = summarizeHttpErrorDetails(details);
  if (!summary) {
    return base;
  }
  return `${base}: ${summary}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch (error) {
      throw new Error('Failed to parse JSON response body', { cause: error });
    }
  }

  const text = await response.text();
  return text ? { message: text } : undefined;
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof XyteHttpError) {
    return error.status >= 500;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return error instanceof TypeError;
}

export class HttpTransport {
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryBackoffMs: number;
  private get logger() { return getLogger(); }

  constructor(options: TransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retryAttempts = options.retryAttempts ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 250;
  }

  async request<T = unknown>(request: TransportRequest): Promise<TransportResponse<T>> {
    const idempotent =
      request.idempotent ?? ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(request.method.toUpperCase());
    const maxAttempts = idempotent ? this.retryAttempts + 1 : 1;
    const started = Date.now();
    const requestId = request.requestId ?? 'none';

    return withSpan(
      'xyte.http.request',
      {
        'xyte.request.id': requestId,
        'xyte.endpoint.key': request.endpointKey ?? 'unknown',
        'http.method': request.method,
        'http.url': request.url,
        'xyte.idempotent': idempotent
      },
      async (span) => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? this.timeoutMs);

          try {
            const response = await fetch(request.url, {
              method: request.method,
              headers: request.headers,
              body: request.body,
              signal: controller.signal
            });
            clearTimeout(timeout);

            const parsed = await parseResponseBody(response);
            if (!response.ok) {
              throw new XyteHttpError({
                message: buildHttpErrorMessage(response.status, response.statusText, parsed),
                status: response.status,
                statusText: response.statusText,
                endpointKey: request.endpointKey,
                details: parsed,
                headers: toLowerCaseMap(response.headers)
              });
            }

            span.setAttribute('http.status_code', response.status);
            span.setAttribute('xyte.attempt', attempt);

            const meta: TransportMeta = {
              durationMs: Date.now() - started,
              attempts: attempt,
              retryCount: attempt - 1
            };

            this.logger.debug(
              {
                requestId,
                endpointKey: request.endpointKey,
                method: request.method,
                url: request.url,
                status: response.status,
                attempts: attempt,
                durationMs: meta.durationMs
              },
              'HTTP request completed'
            );

            return {
              status: response.status,
              headers: toLowerCaseMap(response.headers),
              data: parsed as T,
              meta
            };
          } catch (error) {
            clearTimeout(timeout);
            lastError = error;
            const retryable = attempt < maxAttempts && shouldRetry(error);

            this.logger.debug(
              {
                requestId,
                endpointKey: request.endpointKey,
                method: request.method,
                url: request.url,
                attempt,
                retryable,
                error: errorMessage(error)
              },
              'HTTP request failed'
            );

            if (!retryable) {
              throw error;
            }

            await delay(this.retryBackoffMs * attempt);
          }
        }

        span.setAttribute('xyte.attempt', maxAttempts);
        throw lastError;
      }
    );
  }
}
