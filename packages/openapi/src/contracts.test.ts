import { defineEndpoint, Pylon } from '@ossl/pylon-core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateOpenAPI, generateOpenAPIVersions } from './index.js';

const user = defineEndpoint({
  method: 'POST',
  path: '/accounts/:accountId',
  status: 201,
  contracts: {
    v1: { request: z.object({ name: z.string() }), response: z.object({ id: z.number() }) },
    v2: {
      request: z.object({ fullName: z.string(), role: z.string().default('member') }),
      response: z.object({ id: z.number(), active: z.literal(true) }),
    },
  },
  transforms: {
    'v1->v2': {
      request: (input) => ({ fullName: input.name }),
      response: (output) => ({ id: output.id }),
    },
  },
});

function setup() {
  return new Pylon({
    current: 'v2',
    versions: [
      { name: 'v1', order: 1, deprecated: true },
      { name: 'v2', order: 2, aliases: ['latest'] },
    ],
    endpoints: {
      user,
      health: { method: 'GET', path: '/health', contracts: { v2: { response: z.boolean() } } },
    },
  });
}

describe('OpenAPI endpoint contracts', () => {
  it('exports real method, path, status, input, and output', () => {
    const spec = generateOpenAPI(setup(), { versions: ['v2'] });
    expect(Object.keys(spec.paths)).toEqual(['/accounts/{accountId}', '/health']);
    const post = spec.paths['/accounts/{accountId}']?.post;
    expect(post?.parameters).toEqual(
      expect.arrayContaining([
        { name: 'accountId', in: 'path', required: true, schema: { type: 'string' } },
        expect.objectContaining({
          name: 'api-version',
          in: 'header',
          schema: expect.objectContaining({ enum: ['v2'] }),
        }),
      ]),
    );
    expect(post?.responses['201']?.content).toHaveProperty('application/json');
    expect(post?.requestBody?.required).toBe(true);
    const schemas = Object.values(spec.components?.schemas ?? {});
    expect(schemas.find((schema) => schema.properties?.fullName)?.required).not.toContain('role');
    expect(schemas.find((schema) => schema.properties?.active)?.properties.active).toEqual({
      type: 'boolean',
      const: true,
    });
    expect(spec.paths['/health']?.get?.requestBody).toBeUndefined();
  });

  it('exports independent specs with historical shapes and deprecation', () => {
    const specs = generateOpenAPIVersions(setup());
    expect(specs.v1?.info.version).toBe('v1');
    expect(specs.v2?.info.version).toBe('v2');
    expect(specs.v1?.paths['/health']).toBeUndefined();
    expect(specs.v1?.paths['/accounts/{accountId}']?.post?.deprecated).toBe(true);
    expect(
      Object.values(specs.v1?.components?.schemas ?? {}).some(
        (schema) => schema.properties?.fullName,
      ),
    ).toBe(false);
  });

  it('uses anyOf for overlapping version schemas and retains version association', () => {
    const post = generateOpenAPI(setup()).paths['/accounts/{accountId}']?.post;
    expect(post?.requestBody?.content['application/json']?.schema.anyOf).toHaveLength(2);
    expect(post?.['x-pylon-contracts']).toHaveProperty('v1.response.$ref');
    expect(post?.['x-pylon-contracts']).toHaveProperty('v2.request.$ref');
  });

  it('canonicalizes aliases and removes duplicate schemas', () => {
    const spec = generateOpenAPI(setup(), { versions: ['latest', 'v2'] });
    expect(spec.info.version).toBe('v2');
    expect(
      spec.paths['/accounts/{accountId}']?.post?.requestBody?.content['application/json']?.schema
        .anyOf,
    ).toBeUndefined();
  });

  it('converts recursive references into component-relative pointers', () => {
    const tree: z.ZodType<{ name: string; children: unknown[] }> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(tree) }),
    );
    const spec = generateOpenAPI(
      new Pylon({
        current: 'v1',
        endpoints: {
          tree: { method: 'GET', path: '/tree', contracts: { v1: { response: tree } } },
        },
      }),
    );
    const serialized = JSON.stringify(spec.components?.schemas);
    expect(serialized).toContain('#/components/schemas/tree_0_1_response');
    expect(serialized).not.toContain('"$ref":"#"');
  });

  it('does not execute schema refinements to determine whether a body is optional', () => {
    const refine = vi.fn(async () => true);
    const spec = generateOpenAPI(
      new Pylon({
        current: 'v1',
        endpoints: {
          optional: {
            method: 'POST',
            path: '/optional',
            contracts: { v1: { request: z.string().refine(refine).optional() } },
          },
        },
      }),
    );
    expect(spec.paths['/optional']?.post?.requestBody?.required).toBe(false);
    expect(refine).not.toHaveBeenCalled();
  });

  it('fails with endpoint and direction when a response schema cannot describe JSON', () => {
    const pylon = new Pylon({
      current: 'v1',
      endpoints: {
        date: { method: 'GET', path: '/date', contracts: { v1: { response: z.date() } } },
      },
    });
    expect(() => generateOpenAPI(pylon)).toThrow('Cannot export date v1 response');
  });
});
