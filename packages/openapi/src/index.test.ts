import { Pylon } from '@ossl/pylon-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateOpenAPI, inferPathsFromSchemas, zodToOpenAPISchema } from './index.js';

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

    expect(result.properties?.user?.type).toBe('object');
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

  it('converts ZodUnion to anyOf', () => {
    const result = zodToOpenAPISchema(z.union([z.string(), z.number()]));

    expect(result.anyOf).toHaveLength(2);
    expect(result.anyOf?.[0]?.type).toBe('string');
    expect(result.anyOf?.[1]?.type).toBe('number');
  });

  it('converts ZodIntersection to allOf', () => {
    const result = zodToOpenAPISchema(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
    );

    expect(result.allOf).toHaveLength(2);
    expect(result.allOf?.[0]?.type).toBe('object');
    expect(result.allOf?.[1]?.type).toBe('object');
  });

  it('converts ZodOptional by unwrapping inner type', () => {
    const result = zodToOpenAPISchema(z.string().optional());

    // ZodOptional unwraps to ZodString
    expect(result.type).toBe('string');
  });

  it('converts ZodNullable using JSON Schema null types', () => {
    const result = zodToOpenAPISchema(z.string().nullable());

    expect(result.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  it('converts ZodDefault with default value in result', () => {
    const result = zodToOpenAPISchema(z.string().default('fallback'));

    expect(result.type).toBe('string');
    expect(result.default).toBe('fallback');
  });

  it('converts ZodLiteral number', () => {
    const result = zodToOpenAPISchema(z.literal(42));

    expect(result.type).toBe('number');
    expect(result.const).toBe(42);
  });

  it('converts ZodLiteral string', () => {
    const result = zodToOpenAPISchema(z.literal('active'));

    expect(result.type).toBe('string');
    expect(result.const).toBe('active');
  });

  it('converts ZodLiteral boolean', () => {
    const result = zodToOpenAPISchema(z.literal(true));

    expect(result.type).toBe('boolean');
    expect(result.const).toBe(true);
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
    expect(result.properties?.name?.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  });
});

// ============================================================
// inferPathsFromSchemas
// ============================================================

describe('inferPathsFromSchemas', () => {
  it('does not invent operations from body schemas', () => {
    expect(inferPathsFromSchemas({ v1: z.object({ name: z.string() }) }, ['v1'])).toEqual({});
  });
});

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
    expect(spec.servers?.[0]?.url).toBe('https://api.example.com');
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

  it('exports legacy schemas without inventing routes', () => {
    const spec = generateOpenAPI(createTestPylon());
    expect(spec.paths).toEqual({});
    expect(spec.components?.schemas).toHaveProperty('v1_request');
  });

  it('filters exported legacy schemas', () => {
    const spec = generateOpenAPI(createTestPylon(), { versions: ['v2'] });
    expect(spec.components?.schemas).toHaveProperty('v2_request');
    expect(spec.components?.schemas).not.toHaveProperty('v1_request');
  });

  it('rejects unknown requested versions', () => {
    expect(() => generateOpenAPI(createTestPylon(), { versions: ['v99'] })).toThrow(
      'Unknown OpenAPI version',
    );
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

    const themeSchema = spec.components!.schemas!['v1_request'].properties!.theme;
    expect(themeSchema.default).toBe('light');
  });
});
