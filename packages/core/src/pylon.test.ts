import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Pylon } from './pylon.js';

const schemaV1 = z.object({
  name: z.string(),
  version: z.string().optional(),
});

const schemaV2 = z.object({
  fullName: z.string(),
  email: z.string().email().optional(),
  version: z.string().optional(),
});

function createPylon(overrides: Record<string, any> = {}) {
  return new Pylon({
    current: 'v2',
    versions: { format: 'semantic' },
    schemas: {
      v1: schemaV1,
      v2: schemaV2,
    },
    transforms: {
      'v1->v2': {
        request: (input: any) => ({
          fullName: input.name,
          email: input.email,
          version: 'v2',
        }),
      },
      'v2->v1': {
        response: (input: any) => ({
          name: input.fullName,
          email: input.email,
          version: 'v1',
        }),
      },
    },
    versioning: {
      sources: [
        { type: 'header', name: 'api-version' },
        { type: 'path', pattern: /\/(v\d+)\/?/ },
        { type: 'query', name: 'api_version' },
      ],
    },
    ...overrides,
  });
}

describe('Pylon', () => {
  describe('processRequest', () => {
    it('detects version and transforms body', async () => {
      const pylon = createPylon();
      const result = await pylon.processRequest(
        { 'api-version': 'v1' },
        '/users',
        {},
        { name: 'John', email: 'john@test.com' },
      );
      expect(result.version).toBe('v1');
      expect(result.body).toEqual({
        fullName: 'John',
        email: 'john@test.com',
        version: 'v2',
      });
    });

    it('uses options.version override', async () => {
      const pylon = createPylon();
      const result = await pylon.processRequest(
        {},
        '/users',
        {},
        { name: 'John' },
        { version: 'v1' },
      );
      expect(result.version).toBe('v1');
      expect(result.body).toEqual({
        fullName: 'John',
        version: 'v2',
      });
    });

    it('passes through when client version equals current', async () => {
      const pylon = createPylon();
      const result = await pylon.processRequest(
        { 'api-version': 'v2' },
        '/users',
        {},
        { fullName: 'John' },
      );
      expect(result.version).toBe('v2');
      expect(result.body).toEqual({ fullName: 'John' });
    });

    it('returns default version when detection fails', async () => {
      const pylon = createPylon();
      const result = await pylon.processRequest({}, '/users', {}, {});
      expect(result.version).toBe('v2');
    });
  });

  describe('processResponse', () => {
    it('transforms response body back from v2 to v1', async () => {
      const pylon = createPylon();
      const reqResult = await pylon.processRequest(
        { 'api-version': 'v1' },
        '/users',
        {},
        { name: 'John', email: 'john@test.com' },
      );

      const resResult = await pylon.processResponse(
        reqResult.version,
        { fullName: 'John', email: 'john@test.com' },
        { 'content-type': 'application/json' },
        ['v1->v2'],
      );

      expect(resResult.body).toEqual({
        name: 'John',
        email: 'john@test.com',
        version: 'v1',
      });
    });

    it('passes through when client version matches current', async () => {
      const pylon = createPylon();
      const result = await pylon.processResponse(
        'v2',
        { fullName: 'John' },
        { 'content-type': 'application/json' },
        [],
      );
      expect(result.body).toEqual({ fullName: 'John' });
    });
  });

  describe('validate', () => {
    it('validates data against schema for a version', () => {
      const pylon = createPylon();
      const validResult = pylon.validate({ name: 'John' }, 'v1');
      expect(validResult.success).toBe(true);

      const invalidResult = pylon.validate({ name: 123 }, 'v1');
      expect(invalidResult.success).toBe(false);
      expect(invalidResult.errors).toBeDefined();
    });

    it('returns success for version without schema', () => {
      const pylon = createPylon();
      const result = pylon.validate({ anything: 'goes' }, 'nonexistent');
      expect(result.success).toBe(true);
    });
  });

  describe('response headers', () => {
    it('includes X-API-Version header', async () => {
      const pylon = createPylon();
      const result = await pylon.processRequest(
        { 'api-version': 'v1' },
        '/users',
        {},
        { name: 'John' },
      );
      expect(result.headers['X-API-Version']).toBe('v2');
    });

    it('includes Deprecation and Sunset headers for deprecated versions', async () => {
      const pylon = createPylon();
      pylon.deprecate('v1', {
        sunsetDate: '2025-01-01',
        migrationGuide: 'https://docs.example.com/migration',
      });

      const result = await pylon.processRequest(
        { 'api-version': 'v1' },
        '/users',
        {},
        { name: 'John' },
      );
      expect(result.headers['Deprecation']).toBe('true');
      expect(result.headers['Sunset']).toBe('2025-01-01');
      expect(result.headers['Link']).toBe('<https://docs.example.com/migration>; rel="sunset"');
    });
  });

  describe('debug info', () => {
    it('includes debug info when debug is enabled', async () => {
      const pylon = createPylon({ debug: { enabled: true } });
      const result = await pylon.processRequest(
        { 'api-version': 'v1' },
        '/users',
        {},
        { name: 'John' },
      );
      expect(result.debug).toBeDefined();
      expect(result.debug?.clientVersion).toBe('v1');
      expect(result.debug?.currentVersion).toBe('v2');
      expect(result.debug?.transformsApplied).toEqual(['v1->v2']);
      expect(result.debug?.originalRequest).toEqual({ name: 'John' });
      expect(result.debug?.transformedRequest).toBeDefined();
      expect(typeof result.debug?.durationMs).toBe('number');
      expect(result.debug?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does not include debug when not enabled', async () => {
      const pylon = createPylon();
      const result = await pylon.processRequest(
        { 'api-version': 'v1' },
        '/users',
        {},
        { name: 'John' },
      );
      expect(result.debug).toBeUndefined();
    });

    it('includes debug header when debug is enabled', async () => {
      const pylon = createPylon({ debug: { enabled: true, header: 'X-Debug' } });
      const result = await pylon.processRequest(
        { 'api-version': 'v1' },
        '/users',
        {},
        { name: 'John' },
      );
      expect(result.headers['X-Debug']).toBe('enabled');
    });
  });

  describe('rollback', () => {
    it('unpublish, publish, retire lifecycle', async () => {
      const pylon = createPylon();

      // Assert version is valid
      expect(pylon.normalizer.isValid('v1')).toBe(true);

      // Rollback (unpublish) v1
      await pylon.rollback('v1', {
        reason: 'Breaking change in v1',
        fallback: 'v2',
        mode: 'reject',
      });

      expect(pylon.isUnpublished('v1')).toBe(true);
      const rollback = pylon.getRollback('v1');
      expect(rollback?.reason).toBe('Breaking change in v1');
      expect(rollback?.mode).toBe('reject');
      expect(rollback?.active).toBe(true);

      // Re-publish
      await pylon.publish('v1');
      expect(pylon.isUnpublished('v1')).toBe(false);
      expect(pylon.getRollback('v1')).toBeUndefined();

      // Retire
      await pylon.retire('v1', {
        sunsetDate: '2024-12-31',
        migrationGuide: 'https://docs.example.com/migrate-v2',
      });

      expect(pylon.isUnpublished('v1')).toBe(true);
      expect(pylon.isDeprecated('v1')).toBe(true);
    });

    it('throws when rolling back unknown version', async () => {
      const pylon = createPylon();
      await expect(
        pylon.rollback('v99', {
          reason: 'test',
          fallback: 'v2',
        }),
      ).rejects.toThrow('Cannot rollback unknown version');
    });
  });

  describe('forEndpoint', () => {
    it('creates a scoped Pylon instance', () => {
      const pylon = createPylon({
        endpoints: {
          'users.create': {
            schemas: {
              v1: z.object({ userId: z.string() }),
            },
            transforms: {
              'v1->v2': {
                request: (input: any) => ({ ...input, scoped: true }),
              },
            },
          },
        },
      });

      const scoped = pylon.forEndpoint('users.create');
      expect(scoped).toBeInstanceOf(Pylon);
      // Scoped instance has merged transforms
      expect(scoped.config.transforms['v1->v2']).toBeDefined();
    });

    it('returns same instance for unknown endpoint', () => {
      const pylon = createPylon();
      const scoped = pylon.forEndpoint('nonexistent');
      expect(scoped).toBeInstanceOf(Pylon);
    });
  });

  describe('deprecate', () => {
    it('marks version as deprecated', () => {
      const pylon = createPylon();
      pylon.deprecate('v1', {
        sunsetDate: '2025-06-01',
        migrationGuide: 'https://docs.example.com/migration',
      });

      expect(pylon.isDeprecated('v1')).toBe(true);

      // Process request should include deprecation headers
    });

    it('isDeprecated returns false for non-deprecated versions', () => {
      const pylon = createPylon();
      expect(pylon.isDeprecated('v2')).toBe(false);
    });
  });

  describe('detectVersion', () => {
    it('delegates to VersionDetector', () => {
      const pylon = createPylon();
      const result = pylon.detectVersion({ 'api-version': 'v1' }, '/users', {});
      expect(result.version).toBe('v1');
      expect(result.source).toBe('header');
    });
  });

  describe('transform', () => {
    it('transforms data between versions', async () => {
      const pylon = createPylon();
      const result = await pylon.transform('v1', 'v2', 'request', {
        name: 'John',
      });
      expect(result.status).toBe('success');
      expect(result.data).toEqual({
        fullName: 'John',
        version: 'v2',
      });
    });
  });

  describe('constructor validation', () => {
    it('throws for invalid config', () => {
      expect(
        () =>
          new Pylon({
            current: 'v2',
            schemas: {},
            // @ts-expect-error - intentionally missing transforms
            transforms: null,
          }),
      ).toThrow('Pylon config validation failed');
    });
  });
});
