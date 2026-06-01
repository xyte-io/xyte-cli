import { describe, expect, it } from 'vitest';

import { parseSettingValue, SUPPORTED_SETTING_KEYS } from '../src/config/settings';

describe('parseSettingValue', () => {
  it('throws for unknown key', () => {
    expect(() => parseSettingValue('nonexistent.key', 'value')).toThrow('Unknown config key');
  });

  it('parses output.mode as enum', () => {
    expect(parseSettingValue('output.mode', 'json')).toBe('json');
    expect(parseSettingValue('output.mode', 'text')).toBe('text');
    expect(parseSettingValue('output.mode', 'auto')).toBe('auto');
  });

  it('parses auth.secretStoreBackend as enum', () => {
    expect(parseSettingValue('auth.secretStoreBackend', 'auto')).toBe('auto');
    expect(parseSettingValue('auth.secretStoreBackend', 'native')).toBe('native');
    expect(parseSettingValue('auth.secretStoreBackend', 'file')).toBe('file');
  });

  it('throws for invalid output.mode', () => {
    expect(() => parseSettingValue('output.mode', 'xml')).toThrow('Invalid');
  });

  it('parses boolean settings', () => {
    expect(parseSettingValue('output.strictJson', 'true')).toBe(true);
    expect(parseSettingValue('output.strictJson', 'false')).toBe(false);
    expect(parseSettingValue('output.strictJson', '1')).toBe(true);
    expect(parseSettingValue('output.strictJson', '0')).toBe(false);
    expect(parseSettingValue('output.strictJson', 'yes')).toBe(true);
    expect(parseSettingValue('output.strictJson', 'no')).toBe(false);
  });

  it('parses positive integer settings', () => {
    expect(parseSettingValue('watch.intervalMs', '5000')).toBe(5000);
    expect(parseSettingValue('http.retryAttempts', '3')).toBe(3);
  });

  it('throws for non-positive integer', () => {
    expect(() => parseSettingValue('http.retryAttempts', '0')).toThrow('Invalid');
    expect(() => parseSettingValue('http.retryAttempts', '-1')).toThrow('Invalid');
  });

  it('parses string settings', () => {
    expect(parseSettingValue('defaults.tenant', 'my-tenant')).toBe('my-tenant');
  });
});

describe('SUPPORTED_SETTING_KEYS', () => {
  it('is a non-empty array of strings', () => {
    expect(SUPPORTED_SETTING_KEYS.length).toBeGreaterThan(0);
    SUPPORTED_SETTING_KEYS.forEach((key) => expect(typeof key).toBe('string'));
  });

  it('includes known keys', () => {
    expect(SUPPORTED_SETTING_KEYS).toContain('auth.secretStoreBackend');
    expect(SUPPORTED_SETTING_KEYS).toContain('output.mode');
    expect(SUPPORTED_SETTING_KEYS).toContain('defaults.tenant');
    expect(SUPPORTED_SETTING_KEYS).toContain('http.retryAttempts');
  });
});
