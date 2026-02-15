import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('xyte-cli');

export function withSpan<T>(name: string, attributes: Attributes, operation: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
