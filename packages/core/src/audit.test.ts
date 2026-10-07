import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { auditConfig } from './audit.js';
import { defineConfig } from './config.js';
import { Pylon } from './pylon.js';

describe('config audit', () => {
  it('checks legacy gaps without invoking migrations', () => {
    const request = vi.fn((input) => input);
    const report = auditConfig({
      current: 'v3',
      versions: ['v1', 'v2', 'v3'],
      transforms: { 'v1->v2': { request } },
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join('\n')).toContain('Missing transform');
    expect(request).not.toHaveBeenCalled();
  });
  it('reports implicit identity and unknown version references', () => {
    const report = auditConfig({
      current: 'v2',
      versions: ['v1', 'v2'],
      schemas: { v0: z.unknown() },
      transforms: { 'v1->v2': { request: 'identity' } },
    });
    expect(report.warnings.join()).toContain('implicit response identity');
    expect(report.errors.join()).toContain('unknown version "v0"');
  });
  it('does not require unused global migrations in a contract-only project', () => {
    const report = auditConfig({
      current: 'v2',
      versions: ['v1', 'v2'],
      endpoints: {
        users: {
          method: 'GET',
          path: '/users',
          contracts: { v1: {}, v2: {} },
          transforms: { 'v1->v2': { request: 'identity', response: 'identity' } },
        },
      },
    });
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual([]);
  });
  it('rejects options that have no implementation', () => {
    const report = auditConfig({ current: 'v1', observability: { metrics: true } } as never);
    expect(report.valid).toBe(false);
    expect(report.errors.join()).toContain('Unsupported option "metrics"');
  });
  it('accepts frozen input without mutating caller config', () => {
    const input = Object.freeze({ current: 'v1' });
    expect(defineConfig(input).schemas).toEqual({});
    expect(input).not.toHaveProperty('schemas');
  });
  it('uses one version header by default for endpoint contracts', () => {
    const pylon = new Pylon({
      current: 'v1',
      endpoints: { user: { method: 'GET', path: '/users', contracts: { v1: {} } } },
    });
    expect(pylon.config.versioning?.sources).toEqual([{ type: 'header', name: 'api-version' }]);
    expect(() => pylon.forEndpoint('toString')).toThrow('Unknown Pylon endpoint');
  });
});
