import { describe, expect, it } from 'vitest';

import { redactSensitiveData, redactSensitiveText } from '../src/utils/redact';

describe('redaction utility', () => {
  it('redacts inline sensitive values in free text', () => {
    const message = 'request failed: api_key=abc123 authorization: Bearer token-value-1234';
    const redacted = redactSensitiveText(message);

    expect(redacted).toContain('api_key=[REDACTED]');
    expect(redacted).toContain('authorization: [REDACTED]');
    expect(redacted).not.toContain('authorization: [REDACTED] [REDACTED]');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('token-value-1234');
  });

  it('redacts nested object values by field name and url query params', () => {
    const payload = {
      keep: 'ok',
      apiKey: 'secret-key',
      nested: {
        authorization: 'Bearer top-secret-token',
        url: 'https://api.xyte.io/devices?token=abc123&page=1'
      },
      items: [{ token: 'abc' }, { safe: 'value' }]
    };

    const redacted = redactSensitiveData(payload);

    expect(redacted.keep).toBe('ok');
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.nested.authorization).toBe('[REDACTED]');
    expect(redacted.nested.url).toContain('token=[REDACTED]');
    expect(redacted.items[0].token).toBe('[REDACTED]');
    expect(redacted.items[1].safe).toBe('value');
  });
});
