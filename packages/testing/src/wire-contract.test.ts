import { defineEndpoint, Pylon } from '@ossl/pylon-core';
import { pylonHono } from '@ossl/pylon-hono';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assertContract, snapshotVersion, timeTravel } from './index.js';

const endpoint = defineEndpoint({
  method: 'POST',
  path: '/users',
  contracts: {
    v1: { request: z.object({ name: z.string() }), response: z.object({ id: z.number() }) },
    v2: {
      request: z.object({ fullName: z.string() }),
      response: z.object({ id: z.number(), email: z.string() }),
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
  const pylon = new Pylon({
    current: 'v2',
    versions: ['v1', 'v2'],
    endpoints: { users: endpoint },
  });
  const app = new Hono();
  app.use('*', pylonHono(pylon));
  app.post('/users', (c) => c.json({ id: 1, email: 'private@example.com' }));
  const fetch: typeof globalThis.fetch = async (input, init) => app.fetch(new Request(input, init));
  return { pylon, fetch };
}

it('checks contract fixtures through schema parsing and accepts explicit undefined/null bodies', async () => {
  const pylon = new Pylon({
    current: 'v2',
    versions: ['v1', 'v2'],
    endpoints: {
      bodyless: defineEndpoint({
        method: 'POST',
        path: '/empty',
        contracts: {
          v1: { response: z.null() },
          v2: { request: z.object({ count: z.number().default(2) }), response: z.null() },
        },
        transforms: { 'v1->v2': { request: () => ({}), response: 'identity' } },
      }),
    },
  }).forEndpoint('bodyless');
  await assertContract(pylon, 'v1->v2', {
    sampleInput: undefined,
    sampleResponse: null,
    check: (output, original, direction) =>
      direction === 'request'
        ? original === undefined && output.count === 2
        : original === null && output === null,
  });
});

it('detects value loss when a migration mutates its input fixture', async () => {
  const pylon = new Pylon({
    current: 'v2',
    versions: ['v1', 'v2'],
    transforms: {
      'v1->v2': {
        request: (input) => {
          input.name = 'changed';
          return input;
        },
      },
    },
  });
  await expect(
    assertContract(pylon, 'v1->v2', { sampleInput: { name: 'Ada' }, noDataLoss: true }),
  ).rejects.toThrow('value changed');
});

describe('wire contract testing', () => {
  it('checks actual lossy responses without reconstructing dropped fields', async () => {
    const { pylon, fetch } = setup();
    const transform = vi.spyOn(pylon, 'transform');
    await timeTravel(
      pylon,
      async (version, request) => {
        const response = await request('POST', '/users', {
          body: version === 'v1' ? { name: 'Ada' } : { fullName: 'Ada' },
        });
        expect(response.status).toBe(200);
        expect(response.body).toEqual(
          version === 'v1' ? { id: 1 } : { id: 1, email: 'private@example.com' },
        );
      },
      { fetch },
    );
    expect(transform).not.toHaveBeenCalled();
  });

  it('snapshots distinct wire responses and supplies version to fixture callback', async () => {
    const { pylon, fetch } = setup();
    const snapshots = await snapshotVersion(
      pylon,
      async (request, version) => {
        return (
          await request('POST', '/users', {
            body: version === 'v1' ? { name: 'Ada' } : { fullName: 'Ada' },
          })
        ).body;
      },
      { fetch },
    );
    expect(snapshots).toEqual([
      { version: 'v1', data: { id: 1 } },
      { version: 'v2', data: { id: 1, email: 'private@example.com' } },
    ]);
  });

  it('canonicalizes aliases and deduplicates requested versions', async () => {
    const pylon = new Pylon({
      current: 'v2',
      versions: [
        { name: 'v1', order: 1 },
        { name: 'v2', order: 2, aliases: ['latest'] },
      ],
    });
    const callback = vi.fn(async (_version: string) => {});
    await timeTravel(pylon, callback, { versions: ['latest', 'v2'] });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toBe('v2');
  });

  it.each(['query', 'body'] as const)('injects configured %s version source', async (type) => {
    const pylon = new Pylon({
      current: 'v1',
      versioning: { sources: [{ type, name: 'api_version' }] },
    });
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    await timeTravel(
      pylon,
      async (_, request) => {
        await request('POST', '/users', { body: { name: 'Ada' } });
      },
      { fetch },
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    if (type === 'query') expect(new URL(url).searchParams.get('api_version')).toBe('v1');
    else expect(JSON.parse(String(init.body)).api_version).toBe('v1');
  });

  it('uses explicit path templates and refuses false version coverage', async () => {
    const pylon = new Pylon({
      current: 'v2',
      versions: ['v1', 'v2'],
      versioning: { sources: [{ type: 'path' }] },
    });
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    await expect(
      timeTravel(
        pylon,
        async (_, request) => {
          await request('GET', '/users');
        },
        { fetch },
      ),
    ).rejects.toThrow('Test request selects');
    await timeTravel(
      pylon,
      async (_, request) => {
        await request('GET', '/{version}/users');
      },
      { fetch },
    );
    expect(fetch.mock.calls).toHaveLength(2);
  });

  it('does not parse empty JSON responses', async () => {
    await timeTravel(
      new Pylon({ current: 'v1' }),
      async (_, request) => {
        expect((await request('GET', '/users')).body).toBeUndefined();
      },
      {
        fetch: async () =>
          new Response(null, { status: 204, headers: { 'content-type': 'application/json' } }),
      },
    );
  });

  it('supports explicit rename assertions and detects changed values', async () => {
    const pylon = setup().pylon.forEndpoint('users');
    await expect(
      assertContract(pylon, 'v1->v2', {
        sampleInput: { name: 'Ada' },
        noDataLoss: true,
        fieldMap: { name: 'fullName' },
      }),
    ).resolves.toBeUndefined();
    const broken = new Pylon({
      ...pylon.config,
      transforms: {
        'v1->v2': {
          request: () => ({ fullName: 'different' }),
          response: 'identity',
        },
      },
    });
    await expect(
      assertContract(broken, 'v1->v2', {
        sampleInput: { name: 'Ada' },
        noDataLoss: true,
        fieldMap: { name: 'fullName' },
      }),
    ).rejects.toThrow('value changed');
  });

  it('requires independent response fixtures for contract assertions', async () => {
    const pylon = setup().pylon.forEndpoint('users');
    await expect(
      assertContract(pylon, 'v1->v2', { sampleInput: { name: 'Ada' }, reversible: true }),
    ).rejects.toThrow('independent');
    await assertContract(pylon, 'v1->v2', {
      sampleInput: { name: 'Ada' },
      sampleResponse: { id: 1, email: 'private' },
      check: (output, _, direction) =>
        direction === 'request'
          ? output.fullName === 'Ada'
          : output.id === 1 && !('email' in output),
    });
  });
});
