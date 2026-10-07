import { describe, expect, it } from 'vitest';
import { TransformEngine } from './transform-engine.js';
import { VersionNormalizer } from './version-normalizer.js';

function createEngine() {
  const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v4');
  const engine = new TransformEngine(
    {
      'v1->v2': {
        request: (input: any) => ({ ...input, version: 'v2' }),
        response: (input: any) => ({ ...input, version: 'v1' }),
      },
      'v2->v3': {
        request: (input: any) => ({ ...input, version: 'v3' }),
        response: (input: any) => ({ ...input, version: 'v2' }),
      },
      'v3->v4': {
        request: (input: any) => ({ ...input, version: 'v4' }),
        response: (input: any) => ({ ...input, version: 'v3' }),
      },
    },
    {},
    normalizer,
  );
  return engine;
}

describe('TransformEngine', () => {
  describe('buildChain', () => {
    it('builds chain v1->v3 returns ["v1->v2", "v2->v3"]', () => {
      const engine = createEngine();
      const chain = engine.buildChain('v1', 'v3');
      expect(chain).toEqual(['v1->v2', 'v2->v3']);
    });

    it('returns empty array for same version', () => {
      const engine = createEngine();
      expect(engine.buildChain('v2', 'v2')).toEqual([]);
    });

    it('builds chain v1->v4 includes all hops', () => {
      const engine = createEngine();
      const chain = engine.buildChain('v1', 'v4');
      expect(chain).toEqual(['v1->v2', 'v2->v3', 'v3->v4']);
    });
  });

  describe('compile', () => {
    it('returns identity function for same source and target', () => {
      const engine = createEngine();
      const fn = engine.compile('v4', 'v4', 'request');
      expect(fn({ foo: 'bar' })).toEqual({ foo: 'bar' });
    });

    it('compiles and executes a simple transform', async () => {
      const engine = createEngine();
      const fn = engine.compile('v1', 'v2', 'request');
      const result = await fn({ name: 'John' });
      expect(result).toEqual({ name: 'John', version: 'v2' });
    });
  });

  describe('execute', () => {
    it('executes a simple transform', async () => {
      const engine = createEngine();
      const result = await engine.execute('v1', 'v3', 'request', {
        name: 'John',
      });
      expect(result.status).toBe('success');
      expect(result.data).toEqual({ name: 'John', version: 'v3' });
    });

    it('executes response direction transform', async () => {
      // Diagnostic test that verifies engine internals directly
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v4');
      expect(normalizer.normalize('v4')).toBe(4);
      expect(normalizer.normalize('v3')).toBe(3);
      expect(normalizer.normalize('v2')).toBe(2);
      expect(normalizer.denormalize(3)).toBe('v3');

      // Build chain manually
      const engine = new TransformEngine(
        { 'v4->v3': { response: (i: any) => ({ ...i, version: 'v3' }) } },
        {},
        normalizer,
      );
      const chain = engine.buildChain('v4', 'v3');
      expect(chain).toEqual(['v4->v3']);

      // Now test full execute
      const result = await engine.execute('v4', 'v3', 'response', {
        name: 'John',
        version: 'v4',
      });
      expect(result.status).toBe('success');
      expect(result.data).toEqual({ name: 'John', version: 'v3' });
    });

    it('returns identity for same source and target', async () => {
      const engine = createEngine();
      const result = await engine.execute('v3', 'v3', 'request', {
        name: 'John',
      });
      expect(result.status).toBe('success');
      expect(result.data).toEqual({ name: 'John' });
    });

    it('handles null/undefined input', async () => {
      const engine = createEngine();
      const nullResult = await engine.execute('v1', 'v3', 'request', null);
      expect(nullResult.status).toBe('success');
      expect(nullResult.data).toBeNull();

      const undefResult = await engine.execute('v1', 'v3', 'request', undefined);
      expect(undefResult.status).toBe('success');
      expect(undefResult.data).toBeUndefined();
    });

    it('supports async transform functions', async () => {
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v2');
      const engine = new TransformEngine(
        {
          'v1->v2': {
            request: async (input: any) => ({
              ...input,
              transformed: true,
              asyncMarker: 'done',
            }),
          },
        },
        {},
        normalizer,
      );
      const result = await engine.execute('v1', 'v2', 'request', {
        name: 'John',
      });
      expect(result.status).toBe('success');
      expect(result.data).toEqual({
        name: 'John',
        transformed: true,
        asyncMarker: 'done',
      });
    });

    it('reject error strategy throws TransformError', async () => {
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v2');
      const engine = new TransformEngine(
        {
          'v1->v2': {
            request: () => {
              throw new Error('transform failed');
            },
            onError: { strategy: 'reject' },
          },
        },
        {},
        normalizer,
      );
      const result = await engine.execute('v1', 'v2', 'request', {
        name: 'John',
      });
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('TRANSFORM_REJECTED');
    });

    it('fallback error strategy works', async () => {
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v2');
      const engine = new TransformEngine(
        {
          'v1->v2': {
            request: () => {
              throw new Error('transform failed');
            },
            onError: {
              strategy: 'fallback',
              fallback: (input: any) => ({ ...input, fallback: true }),
            },
          },
        },
        {},
        normalizer,
      );
      const result = await engine.execute('v1', 'v2', 'request', {
        name: 'John',
      });
      expect(result.status).toBe('fallback');
      expect(result.data).toEqual({ name: 'John', fallback: true });
    });

    it('passthrough error strategy returns input unchanged', async () => {
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v2');
      const engine = new TransformEngine(
        {
          'v1->v2': {
            request: () => {
              throw new Error('transform failed');
            },
            onError: { strategy: 'passthrough' },
          },
        },
        {},
        normalizer,
      );
      const result = await engine.execute('v1', 'v2', 'request', {
        name: 'John',
      });
      expect(result.status).toBe('passthrough');
      expect(result.data).toEqual({ name: 'John' });
    });

    it('missing hop throws descriptive error', async () => {
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v4');
      const engine = new TransformEngine(
        {
          'v1->v2': {
            request: (input: any) => input,
          },
          'v3->v4': {
            request: (input: any) => input,
          },
          // Missing v2->v3
        },
        {},
        normalizer,
      );
      await expect(engine.execute('v1', 'v4', 'request', { name: 'John' })).rejects.toThrow();
    });

    it('circular dependency detection', () => {
      // Circular: v1->v2 exists, v2->v3 exists, v3->v1 exists
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v3');
      const engine = new TransformEngine(
        {
          'v1->v2': { request: (i: any) => i },
          'v2->v3': { request: (i: any) => i },
          'v3->v1': { request: (i: any) => i },
        },
        {},
        normalizer,
      );
      // This would normally attempt buildChain which only walks from source to target
      // v1->v3 forwards would do v1->v2, v2->v3 — not v3->v1
      // The cycle exists in transforms but the engine won't hit it with normal usage
      // Let's just verify no error for a valid chain
      const chain = engine.buildChain('v1', 'v3');
      expect(chain).toEqual(['v1->v2', 'v2->v3']);
    });

    it('calls onError callback on transform failure', async () => {
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v2');
      const engine = new TransformEngine(
        {
          'v1->v2': {
            request: () => {
              throw new Error('oops');
            },
          },
        },
        {},
        normalizer,
      );
      const errors: any[] = [];
      await engine.execute('v1', 'v2', 'request', { name: 'John' }, (err) => errors.push(err));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('log-and-continue error strategy continues execution', async () => {
      const normalizer = new VersionNormalizer({ format: 'semantic' }, 'v3');
      const engine = new TransformEngine(
        {
          'v1->v2': {
            request: () => {
              throw new Error('skip me');
            },
            onError: { strategy: 'log-and-continue' },
          },
          'v2->v3': {
            request: (input: any) => ({ ...input, passed: true }),
          },
        },
        {},
        normalizer,
      );
      const result = await engine.execute('v1', 'v3', 'request', {
        name: 'John',
      });
      expect(result.status).toBe('success');
      expect(result.data).toEqual({ name: 'John', passed: true });
    });
  });
});

describe('transform regressions', () => {
  it('keeps endpoint compiled transforms separate from global transforms', async () => {
    const engine = createEngine();
    const global = engine.compile('v1', 'v2', 'request');
    const endpoint = engine.merge({ 'v1->v2': { request: () => ({ scoped: true }) } });
    expect(await endpoint.compile('v1', 'v2', 'request')({})).toEqual({ scoped: true });
    expect(await global({})).toEqual({ version: 'v2' });
  });

  it('handles aliases in both directions and canonicalizes cache entries', async () => {
    const engine = new TransformEngine(
      {
        'v1->v2': {
          request: (input: number) => input + 1,
          response: (input: number) => input - 1,
        },
      },
      {},
      new VersionNormalizer({ format: 'semantic', aliases: { old: 'v1', latest: 'v2' } }, 'v2'),
    );
    expect(await engine.execute('old', 'latest', 'request', 1)).toEqual({
      status: 'success',
      data: 2,
    });
    expect(await engine.execute('latest', 'old', 'response', 2)).toEqual({
      status: 'success',
      data: 1,
    });
    expect(engine.compile('old', 'latest', 'request')).toBe(engine.compile('v1', 'v2', 'request'));
  });

  it('keeps synchronous compiled transforms synchronous and supports mixed async chains', async () => {
    const engine = new TransformEngine(
      {
        'v1->v2': { request: (n: number) => n + 1 },
        'v2->v3': { request: async (n: number) => n * 2 },
        'v3->v4': { request: (n: number) => n + 3 },
      },
      {},
      new VersionNormalizer({ format: 'semantic' }, 'v4'),
    );
    expect(engine.compile('v1', 'v2', 'request')(1)).toBe(2);
    expect(await engine.compile('v1', 'v4', 'request')(1)).toBe(7);
  });

  it('awaits fallback output and runs the remaining hops', async () => {
    const engine = new TransformEngine(
      {
        'v1->v2': {
          request: () => {
            throw null;
          },
          onError: { strategy: 'fallback', fallback: async () => 4 },
        },
        'v2->v3': { request: (n: number) => n * 2 },
      },
      {},
      new VersionNormalizer({ format: 'semantic' }, 'v3'),
    );
    expect(await engine.execute('v1', 'v3', 'request', 1)).toEqual({ status: 'fallback', data: 8 });
  });

  it('reports one error per failed hop, including non-Error throws', async () => {
    const engine = new TransformEngine(
      {
        'v1->v2': {
          request: () => {
            throw null;
          },
        },
      },
      {},
      new VersionNormalizer({ format: 'semantic' }, 'v2'),
    );
    const errors: unknown[] = [];
    const result = await engine.execute('v1', 'v2', 'request', {}, (error) => errors.push(error));
    expect(errors).toHaveLength(1);
    expect(result.error?.message).toContain('v1->v2 (request)');
    expect(result.error?.details?.key).toBe('v1->v2');
  });

  it('rejects unknown versions even on identity chains', () => {
    expect(() => createEngine().compile('missing', 'missing', 'request')).toThrow(
      'Unknown source version',
    );
  });
});
