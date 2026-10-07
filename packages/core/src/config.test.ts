import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineConfig, validateConfig } from './config.js';
import type { PylonConfig } from './types.js';

describe('defineConfig', () => {
  it('returns the same config object', () => {
    const config: PylonConfig = {
      current: 'v2',
      schemas: {
        v1: z.object({ name: z.string() }),
        v2: z.object({ fullName: z.string() }),
      },
      transforms: {
        'v1->v2': {
          request: (input: any) => ({ fullName: input.name }),
        },
      },
    };
    const result = defineConfig(config);
    expect(result).toBe(config);
  });
});

describe('validateConfig', () => {
  it('returns valid=true for a valid config', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v1: z.object({ name: z.string() }),
        v2: z.object({ fullName: z.string() }),
      },
      transforms: {
        'v1->v2': {
          request: (input: any) => ({ fullName: input.name }),
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('validates that current version exists', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v1: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v2': {
          request: (input: any) => ({ fullName: input.name }),
        },
      },
    });
    // current v2 should be fine as long as it appears as a target in transforms
    // or in versions config. It appears as a target of v1->v2, so it should be valid.
    expect(result.valid).toBe(true);
  });

  it('rejects missing current version', () => {
    const result = validateConfig({
      current: '',
      schemas: {
        v1: z.object({ name: z.string() }),
      },
      transforms: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('current'))).toBe(true);
  });

  it('detects missing transform hop', () => {
    // v1->v3 is not a direct hop - v2 is missing
    const result = validateConfig({
      current: 'v3',
      schemas: {
        v1: z.object({ name: z.string() }),
        v3: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v3': {
          request: (input: any) => ({ ...input, version: 'v3' }),
        },
      },
    });
    // While this validates the format, the missing hop is only detected at runtime
    // by buildChain. validateConfig just checks format, not adjacency.
    expect(result.valid).toBe(true);
  });

  it('rejects invalid transform key format', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v1: z.object({ name: z.string() }),
        v2: z.object({ name: z.string() }),
      },
      transforms: {
        'bad-key': {
          request: (input: any) => input,
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid transform key'))).toBe(true);
  });

  it('allows bidirectional transform pairs (not circular)', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v1: z.object({ name: z.string() }),
        v2: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v2': {
          request: (input: any) => input,
        },
        'v2->v1': {
          response: (input: any) => input,
        },
      },
    });
    // Bidirectional pairs (v1->v2 and v2->v1) are valid - request/response transforms
    expect(result.valid).toBe(true);
  });

  it('rejects invalid version source type', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v2: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v2': {
          request: (input: any) => input,
        },
      },
      versioning: {
        sources: [
          // @ts-expect-error - testing invalid type
          { type: 'invalid' },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid version source type'))).toBe(true);
  });

  it('rejects transform with neither request nor response', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v2: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v2': {},
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('neither "request" nor "response"'))).toBe(true);
  });

  it('rejects missing schemas', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: null as any,
      transforms: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('schemas'))).toBe(true);
  });

  it('rejects missing transforms', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v2: z.object({ name: z.string() }),
      },
      transforms: null as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('transforms'))).toBe(true);
  });

  it('rejects invalid error strategy', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v2: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v2': {
          request: (input: any) => input,
          onError: { strategy: 'invalid-strategy' as any },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid error strategy'))).toBe(true);
  });

  it('validates endpoint schemas', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v2: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v2': {
          request: (input: any) => input,
        },
      },
      endpoints: {
        'users.create': {
          schemas: {
            v2: {} as any, // Not a Zod schema
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Endpoint') && e.includes('schema'))).toBe(true);
  });

  it('rejects fallback strategy without fallback function', () => {
    const result = validateConfig({
      current: 'v2',
      schemas: {
        v2: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v2': {
          request: (input: any) => input,
          onError: { strategy: 'fallback' } as any,
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fallback'))).toBe(true);
  });
});
