import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Pylon } from '@ossl/pylon-core';
import {
  generateOpenAPI,
  zodToOpenAPISchema,
  inferPathsFromSchemas,
} from './index.js';

// ============================================================
// zodToOpenAPISchema
// ============================================================

describe('zodToOpenAPISchema', () => {
  it('converts ZodObject with properties and required fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
      email: z.string().default('a@b.com'),
    });

    const result = zodToOpenAPISchema(schema);

    expect(result.type).toBe('object');
    expect(result.properties).toHaveProperty('name');
    expect(result.properties).toHaveProperty('age');
    expect(result.properties).toHaveProperty('email');
    expect(result.required).toContain('name');
    expect(result.required).not.toContain('age'); // optional
    expect(result.required).not.toContain('email'); // default
  });

  it('converts nested ZodObject recursively', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
      }),
    });

    const result = zodToOpenAPISchema(schema);

    expect(result.properties!.user.type).toBe('object');
    expect((result.properties!.user as any).properties.name).toEqual({ type: 'string' });
  });

  it('converts ZodString with format checks', () => {
    const schema = z.string().email();

    const result = zodToOpenAPISchema(schema);

    expect(result.type).toBe('string');
    expect(result.format).toBe('email');
  });

  it('converts ZodString with url format', () => {
    const result = zodToOpenAPISchema(z.string().url());
    expect(result.format).toBe('uri');
  });

  it('converts ZodString with uuid format', () => {
    const result = zodToOpenAPISchema(z.string().uuid());
    expect(result.format).toBe('uuid');
  });

  it('converts ZodString with min/max length', () => {
    const result = zodToOpenAPISchema(z.string().min(3).max(10));

    expect(result.minLength).toBe(3);
    expect(result.maxLength).toBe(10);
  });

  it('converts ZodString with regex pattern', () => {
    const result = zodToOpenAPISchema(z.string().regex(/^[a-z]+$/));

    expect(result.pattern).toBe('^[a-z]+$');
  });

  it('converts ZodString with default value', () => {
    const result = zodToOpenAPISchema(z.string().default('hello'));

    expect(result.type).toBe('string');
    expect(result.default).toBe('hello');
  });

  it('converts ZodNumber', () => {
    const result = zodToOpenAPISchema(z.number());

    expect(result.type).toBe('number');
  });

  it('converts ZodNumber with minimum/maximum', () => {
    const result = zodToOpenAPISchema(z.number().min(0).max(100));

    expect(result.minimum).toBe(0);
    expect(result.maximum).toBe(100);
  });

  it('converts ZodNumber integer', () => {
    const result = zodToOpenAPISchema(z.number().int());

    expect(result.type).toBe('integer');
  });

  it('converts ZodBoolean', () => {
    const result = zodToOpenAPISchema(z.boolean());
    expect(result.type).toBe('boolean');
  });

  it('converts ZodArray', () => {
    const result = zodToOpenAPISchema(z.array(z.string()));

    expect(result.type).toBe('array');
    expect(result.items).toEqual({ type: 'string' });
  });

  it('converts ZodEnum', () => {
    const result = zodToOpenAPISchema(z.enum(['a', 'b', 'c']));

    expect(result.type).toBe('string');
    expect(result.enum).toEqual(['a', 'b', 'c']);
  });

  it('converts ZodUnion to oneOf', () => {
    const result = zodToOpenAPISchema(z.union([z.string(), z.number()]));

    expect(result.oneOf).toHaveLength(2);
    expect(result.oneOf![0].type).toBe('string');
    expect(result.oneOf![1].type).toBe('number');
  });

  it('converts ZodIntersection to allOf', () => {
    const result = zodToOpenAPISchema(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
    );

    expect(result.allOf).toHaveLength(2);
    expect(result.allOf![0].type).toBe('object');
    expect(result.allOf![1].type).toBe('object');
  });

  it('converts ZodOptional by unwrapping inner type', () => {
    const result = zodToOpenAPISchema(z.string().optional());

    // ZodOptional unwraps to ZodString
    expect(result.type).toBe('string');
  });

  it('converts ZodNullable with nullable flag', () => {
    const result = zodToOpenAPISchema(z.string().nullable());

    expect(result.type).toBe('string');
    expect(result.nullable).toBe(true);
  });

  it('converts ZodDefault with default value in result', () => {
    const result = zodToOpenAPISchema(z.string().default('fallback'));

    expect(result.type).toBe('string');
    expect(result.default).toBe('fallback');
  });

  it('converts ZodLiteral number', () => {
    const result = zodToOpenAPISchema(z.literal(42));

    expect(result.type).toBe('number');
    expect(result.enum).toEqual([42]);
  });

  it('converts ZodLiteral string', () => {
    const result = zodToOpenAPISchema(z.literal('active'));

    expect(result.type).toBe('string');
    expect(result.enum).toEqual(['active']);
  });

  it('converts ZodLiteral boolean (edge case: type string)', () => {
    const result = zodToOpenAPISchema(z.literal(true));

    // Known behavior: boolean literals get type "string"
    expect(result.type).toBe('string');
    expect(result.enum).toEqual([true]);
  });

  it('converts ZodRecord', () => {
    const result = zodToOpenAPISchema(z.record(z.string(), z.number()));

    expect(result.type).toBe('object');
    expect(result.additionalProperties).toEqual({ type: 'number' });
  });

  it('returns {} for z.any()', () => {
    const result = zodToOpenAPISchema(z.any());
    expect(result).toEqual({});
  });

  it('returns {} for z.unknown()', () => {
    const result = zodToOpenAPISchema(z.unknown());
    expect(result).toEqual({});
  });

  it('converts ZodObject with nullable nested property', () => {
    const schema = z.object({
      name: z.string().nullable(),
    });

    const result = zodToOpenAPISchema(schema);

    // Nullable property is NOT optional — it's still required but can be null
    expect(result.required).toContain('name');
    expect(result.properties!.name.nullable).toBe(true);
  });
});

// ============================================================
// inferPathsFromSchemas
// ============================================================

describe('inferPathsFromSchemas', () => {
  it('generates GET and POST paths per version', () => {
    const schemas = {
      v1: z.object({ name: z.string() }),
      v2: z.object({ name: z.string(), email: z.string() }),
    };
    const versions = ['v1', 'v2'];
    const normalizer = {
      listVersions: () => [
        { name: 'v1', order: 1, deprecated: false },
        { name: 'v2', order: 2, deprecated: false },
      ],
    };

    const paths = inferPathsFromSchemas(schemas, versions, normalizer);

    expect(paths).toHaveProperty('/v1/users');
    expect(paths).toHaveProperty('/v2/users');
    expect(paths['/v1/users']).toHaveProperty('get');
    expect(paths['/v1/users']).toHaveProperty('post');
    expect(paths['/v2/users']).toHaveProperty('get');
    expect(paths['/v2/users']).toHaveProperty('post');
  });

  it('uses correct $ref format in responses', () => {
    const schemas = { v1: z.object({ name: z.string() }) };
    const versions = ['v1'];
    const normalizer = {
      listVersions: () => [{ name: 'v1', order: 1, deprecated: false }],
    };

    const paths = inferPathsFromSchemas(schemas, versions, normalizer);

    const getResponse =
      paths['/v1/users'].get!.responses['200'].content!['application/json']
        .schema;
    expect(getResponse.$ref).toBe('#/components/schemas/v1_request');
  });

  it('sanitizes version in operationId', () => {
    const schemas = { '2024-03-15': z.object({ name: z.string() }) };
    const versions = ['2024-03-15'];
    const normalizer = {
      listVersions: () => [
        { name: '2024-03-15', order: 1, deprecated: false },
      ],
    };

    const paths = inferPathsFromSchemas(schemas, versions, normalizer);

    expect(paths['/2024-03-15/users'].get!.operationId).toBe(
      'listUsers_2024_03_15',
    );
  });

  it('marks deprecated versions', () => {
    const schemas = { v1: z.object({ name: z.string() }) };
    const versions = ['v1'];
    const normalizer = {
      listVersions: () => [{ name: 'v1', order: 1, deprecated: true }],
    };

    const paths = inferPathsFromSchemas(schemas, versions, normalizer);

    expect(paths['/v1/users'].get!.deprecated).toBe(true);
    expect(paths['/v1/users'].post!.deprecated).toBe(true);
  });

  it('does not mark non-deprecated versions', () => {
    const schemas = { v1: z.object({ name: z.string() }) };
    const versions = ['v1'];
    const normalizer = {
      listVersions: () => [{ name: 'v1', order: 1, deprecated: false }],
    };

    const paths = inferPathsFromSchemas(schemas, versions, normalizer);

    expect(paths['/v1/users'].get!.deprecated).toBeUndefined();
  });

  it('skips versions missing from schemas', () => {
    const schemas = { v2: z.object({ name: z.string() }) };
    const versions = ['v1', 'v2'];
    const normalizer = {
      listVersions: () => [
        { name: 'v1', order: 1 },
        { name: 'v2', order: 2 },
      ],
    };

    const paths = inferPathsFromSchemas(schemas, versions, normalizer);

    // v1 has no schema, so it should be skipped
    expect(paths).not.toHaveProperty('/v1/users');
    expect(paths).toHaveProperty('/v2/users');
  });

  it('includes X-API-Version header parameter in paths', () => {
    const schemas = { v1: z.object({ name: z.string() }) };
    const versions = ['v1'];
    const normalizer = {
      listVersions: () => [{ name: 'v1', order: 1 }],
    };

    const paths = inferPathsFromSchemas(schemas, versions, normalizer);

    const params = paths['/v1/users'].get!.parameters!;
    expect(params[0].name).toBe('X-API-Version');
    expect(params[0].in).toBe('header');
    expect(params[0].required).toBe(true);
    expect(params[0].schema.default).toBe('v1');
  });
});

// ============================================================
// generateOpenAPI
// ============================================================

describe('generateOpenAPI', () => {
  function createTestPylon() {
    return new Pylon({
      current: 'v2',
      defaultVersion: 'v2',
      versions: [
        { name: 'v1', order: 1, deprecated: true },
        { name: 'v2', order: 2 },
      ],
      schemas: {
        v1: z.object({ name: z.string() }),
        v2: z.object({ name: z.string(), email: z.string().email() }),
      },
      transforms: {
        'v1->v2': { request: (r: any) => r },
      },
      debug: { enabled: false },
    });
  }

  it('generates a valid OpenAPI 3.1.0 spec', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon);

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info).toHaveProperty('title');
    expect(spec.info).toHaveProperty('version');
    expect(spec.paths).toBeDefined();
    expect(spec.components).toBeDefined();
    expect(spec.components!.schemas).toBeDefined();
  });

  it('uses default title and version when no options provided', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon);

    expect(spec.info.title).toBe('API');
    expect(spec.info.version).toBe('v2');
  });

  it('accepts custom info options', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon, {
      info: {
        title: 'My API',
        version: '1.0.0',
        description: 'Test API description',
        contact: { name: 'Dev', email: 'dev@example.com' },
        license: { name: 'MIT' },
      },
    });

    expect(spec.info.title).toBe('My API');
    expect(spec.info.version).toBe('1.0.0');
    expect(spec.info.description).toBe('Test API description');
    expect(spec.info.contact).toEqual({ name: 'Dev', email: 'dev@example.com' });
    expect(spec.info.license).toEqual({ name: 'MIT' });
  });

  it('includes server URLs when provided', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon, {
      servers: [{ url: 'https://api.example.com', description: 'Production' }],
    });

    expect(spec.servers).toHaveLength(1);
    expect(spec.servers![0].url).toBe('https://api.example.com');
  });

  it('includes security schemes when provided', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon, {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    });

    expect(spec.components!.securitySchemes).toHaveProperty('bearerAuth');
    expect((spec.components!.securitySchemes as any).bearerAuth.type).toBe('http');
  });

  it('generates component schemas for each version', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon);

    expect(spec.components!.schemas).toHaveProperty('v1_request');
    expect(spec.components!.schemas).toHaveProperty('v2_request');
    expect(spec.components!.schemas!['v1_request'].type).toBe('object');
  });

  it('generates paths for each version', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon);

    expect(spec.paths).toHaveProperty('/v1/users');
    expect(spec.paths).toHaveProperty('/v2/users');
  });

  it('filters versions when options.versions is specified', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon, { versions: ['v2'] });

    expect(spec.paths).toHaveProperty('/v2/users');
    expect(spec.paths).not.toHaveProperty('/v1/users');
    expect(spec.components!.schemas).toHaveProperty('v2_request');
    expect(spec.components!.schemas).not.toHaveProperty('v1_request');
  });

  it('marks deprecated paths from VersionDefinition', () => {
    const pylon = createTestPylon();
    const spec = generateOpenAPI(pylon);

    const v1Path = spec.paths['/v1/users'] as any;
    expect(v1Path.get.deprecated).toBe(true);
    expect(v1Path.post.deprecated).toBe(true);
  });

  it('skips versions with no schema (graceful)', () => {
    const pylon = createTestPylon();
    // Include a non-existent version
    const spec = generateOpenAPI(pylon, { versions: ['v1', 'v2', 'v3'] });

    expect(spec.paths).toHaveProperty('/v1/users');
    expect(spec.paths).toHaveProperty('/v2/users');
    expect(spec.paths).not.toHaveProperty('/v3/users');
  });

  it('includes default value from Zod schema in OpenAPI output', () => {
    const pylon = new Pylon({
      current: 'v2',
      defaultVersion: 'v2',
      versions: [
        { name: 'v1', order: 1 },
        { name: 'v2', order: 2 },
      ],
      schemas: {
        v1: z.object({ theme: z.string().default('light') }),
        v2: z.object({ theme: z.string().default('dark') }),
      },
      transforms: {
        'v1->v2': { request: (r: any) => r },
      },
      debug: { enabled: false },
    });

    const spec = generateOpenAPI(pylon);

    const themeSchema =
      spec.components!.schemas!['v1_request'].properties!.theme;
    expect(themeSchema.default).toBe('light');
  });
});
