import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { defineConfig } from './config.js';
import type { EndpointInput, EndpointOutput } from './contracts.js';
import { defineEndpoint } from './contracts.js';
import { Pylon } from './pylon.js';
import type { EndpointConfig } from './types.js';

const createUser = defineEndpoint({
  method: 'POST',
  path: '/users',
  status: 201,
  contracts: {
    v1: {
      request: z.object({ name: z.string() }),
      response: z.object({ id: z.number(), name: z.string() }),
    },
    v2: {
      request: z.object({ fullName: z.string() }),
      response: z.object({ id: z.number(), fullName: z.string(), email: z.string() }),
    },
  },
  transforms: {
    'v1->v2': {
      request: (input) => ({ fullName: input.name }),
      response: (output) => ({ id: output.id, name: output.fullName }),
    },
  },
});

function instance(endpoint: EndpointConfig = createUser) {
  return new Pylon({ current: 'v2', versions: ['v1', 'v2'], endpoints: { createUser: endpoint } });
}

describe('endpoint contracts', () => {
  it('reports both directions and scoped request failures through observability hooks', async () => {
    const onTransform = vi.fn();
    const onError = vi.fn();
    const pylon = new Pylon({
      current: 'v2',
      versions: ['v1', 'v2'],
      endpoints: { createUser },
      observability: { onTransform, onError },
    }).forEndpoint('createUser');
    await pylon.processRequest({ 'api-version': 'v1' }, '/users', {}, { name: 'Ada' });
    await pylon.processResponse('v1', { id: 1, fullName: 'Ada', email: 'ada@example.com' }, {}, []);
    expect(onTransform.mock.calls.map(([event]) => [event.direction, event.endpoint])).toEqual([
      ['request', 'createUser'],
      ['response', 'createUser'],
    ]);
    await pylon.processRequest({ 'api-version': 'v1' }, '/users', {}, { name: 1 });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'request',
        endpoint: 'createUser',
        originalError: expect.any(Error),
      }),
    );
  });

  it('parses intermediate defaults and schema transforms before the next typed migration', async () => {
    const middleRequest = vi.fn(() => true);
    const middleResponse = vi.fn((value: number) => String(value));
    const endpoint = defineEndpoint({
      method: 'POST',
      path: '/totals',
      contracts: {
        v1: { request: z.object({ value: z.string() }), response: z.object({ value: z.string() }) },
        v2: {
          request: z
            .object({ value: z.coerce.number(), multiplier: z.number().default(2) })
            .refine(middleRequest),
          response: z.object({ value: z.number().transform(middleResponse) }),
        },
        v3: { request: z.object({ total: z.number() }), response: z.object({ total: z.number() }) },
      },
      transforms: {
        'v1->v2': { request: 'identity', response: 'identity' },
        'v2->v3': {
          request: (input) => ({ total: input.value * input.multiplier }),
          response: (output) => ({ value: output.total / 2 }),
        },
      },
    });
    const pylon = new Pylon({
      current: 'v3',
      versions: ['v1', 'v2', 'v3'],
      endpoints: { totals: endpoint },
    }).forEndpoint('totals');
    expect(
      (await pylon.processRequest({ 'api-version': 'v1' }, '/totals', {}, { value: '10' })).body,
    ).toEqual({ total: 20 });
    expect((await pylon.processResponse('v1', { total: 20 }, {}, [])).body).toEqual({
      value: '10',
    });
    expect(middleRequest).toHaveBeenCalledTimes(1);
    expect(middleResponse).toHaveBeenCalledTimes(1);
    expect(await pylon.engine.compile('v1', 'v3', 'request')({ value: '10' })).toEqual({
      total: 20,
    });
  });

  it('validates fallback output and gives fallbacks the failed hop input', async () => {
    const fallback = vi.fn((input) => ({ fullName: input.name }));
    const pylon = instance({
      ...createUser,
      transforms: {
        'v1->v2': {
          request: () => ({}),
          response: 'identity',
          onError: { strategy: 'fallback', fallback },
        },
      },
    }).forEndpoint('createUser');
    const result = await pylon.processRequest(
      { 'api-version': 'v1' },
      '/users',
      {},
      { name: 'Ada' },
    );
    expect(result.body).toEqual({ fullName: 'Ada' });
    expect(fallback).toHaveBeenCalledWith({ name: 'Ada' });
    expect(result.transformResult.status).toBe('fallback');
  });

  it('rejects unsafe contract rollbacks and defaults to rejecting an unpublished release', async () => {
    const pylon = instance();
    await expect(
      pylon.rollback('v2', { fallback: 'v1', reason: 'broken', mode: 'downgrade' }),
    ).rejects.toThrow('not inverses');
    await pylon.rollback('v2', { fallback: 'v1', reason: 'broken' });
    expect(
      (
        await pylon
          .forEndpoint('createUser')
          .processRequest({ 'api-version': 'v2' }, '/users', {}, { fullName: 'Ada' })
      ).status,
    ).toBe(410);
    await pylon.publish('v2');
    expect(pylon.isUnpublished('v2')).toBe(false);
  });

  it('retains retired hops for serving newer clients and rejects republication', async () => {
    const pylon = new Pylon({
      current: 'v2',
      versions: [
        { name: 'v1', order: 1, retired: true },
        { name: 'v2', order: 2 },
      ],
      endpoints: { createUser },
    });
    expect(
      (
        await pylon
          .forEndpoint('createUser')
          .processRequest({ 'api-version': 'v1' }, '/users', {}, { name: 'Ada' })
      ).status,
    ).toBe(410);
    expect(pylon.normalizer.listVersions()).toHaveLength(2);
    await expect(pylon.publish('v1')).rejects.toThrow('permanently retired');
    expect(
      (
        await pylon
          .forEndpoint('createUser')
          .processRequest({ 'api-version': 'v2' }, '/users', {}, { fullName: 'Ada' })
      ).body,
    ).toEqual({ fullName: 'Ada' });
  });

  it('validates directional schemas through public validation helpers', async () => {
    const pylon = instance().forEndpoint('createUser');
    expect(pylon.validate({ name: 'Ada' }, 'v1').success).toBe(true);
    expect(pylon.validate({ name: 'Ada' }, 'v1', 'response').success).toBe(false);
    expect((await pylon.validateAsync({ id: 1, name: 'Ada' }, 'v1', 'response')).success).toBe(
      true,
    );
    await expect(pylon.transform('v2', 'v1', 'request', { fullName: 'Ada' })).rejects.toThrow(
      'requests upgrade',
    );
  });

  it('infers distinct request and response types', () => {
    expectTypeOf(createUser.transforms?.['v1->v2']?.request)
      .exclude<'identity' | undefined>()
      .parameter(0)
      .toEqualTypeOf<{ name: string }>();
    expectTypeOf(createUser.transforms?.['v1->v2']?.response)
      .exclude<'identity' | undefined>()
      .parameter(0)
      .toEqualTypeOf<{ id: number; fullName: string; email: string }>();
    expectTypeOf<EndpointInput<typeof createUser, 'v2'>>().toEqualTypeOf<{ fullName: string }>();
    expectTypeOf<EndpointOutput<typeof createUser, 'v1'>>().toEqualTypeOf<{
      id: number;
      name: string;
    }>();
    const config = defineConfig({
      current: 'v2',
      versions: ['v1', 'v2'],
      endpoints: { createUser },
    });
    expectTypeOf(config.current).toEqualTypeOf<'v2'>();
  });

  it('upgrades input and downgrades output independently', async () => {
    const pylon = instance().forRoute('POST', '/users');
    const request = await pylon.processRequest(
      { 'api-version': 'v1' },
      '/users',
      {},
      { name: 'Ada' },
    );
    expect(request.body).toEqual({ fullName: 'Ada' });
    const response = await pylon.processResponse(
      request.version,
      { id: 1, fullName: 'Ada', email: 'private' },
      {},
      [],
    );
    expect(response.body).toEqual({ id: 1, name: 'Ada' });
    expect(response.status).toBeUndefined();
  });

  it('rejects malformed historical input before running user transforms', async () => {
    const request = vi.fn(
      createUser.transforms!['v1->v2']!.request as (input: { name: string }) => {
        fullName: string;
      },
    );
    const pylon = instance({
      ...createUser,
      transforms: { 'v1->v2': { ...createUser.transforms!['v1->v2'], request } },
    }).forEndpoint('createUser');
    const result = await pylon.processRequest({ 'api-version': 'v1' }, '/users', {}, {});
    expect(result.status).toBe(422);
    expect(request).not.toHaveBeenCalled();
  });

  it('classifies malformed migrated requests as server errors', async () => {
    const pylon = instance({
      ...createUser,
      transforms: { 'v1->v2': { request: () => ({}), response: 'identity' } },
    }).forEndpoint('createUser');
    const result = await pylon.processRequest(
      { 'api-version': 'v1' },
      '/users',
      {},
      { name: 'Ada' },
    );
    expect(result.status).toBe(500);
    expect(result.transformResult.error?.code).toBe('REQUEST_CONTRACT_FAILED');
  });

  it.each(['v1', 'v2'])('validates handler responses for %s', async (version) => {
    const result = await instance()
      .forEndpoint('createUser')
      .processResponse(version, { id: 'invalid' }, {}, []);
    expect(result.status).toBe(500);
    expect(result.body).toHaveProperty('error.code', 'RESPONSE_TRANSFORM_FAILED');
  });

  it('validates historical responses after migration', async () => {
    const pylon = instance({
      ...createUser,
      transforms: { 'v1->v2': { request: 'identity', response: () => ({}) } },
    }).forEndpoint('createUser');
    expect(
      (await pylon.processResponse('v1', { id: 1, fullName: 'Ada', email: 'x' }, {}, [])).status,
    ).toBe(500);
  });

  it('supports async schemas and migrations', async () => {
    const endpoint = defineEndpoint({
      method: 'POST',
      path: '/async',
      contracts: {
        v1: { request: z.string().transform(async (s) => s.trim()), response: z.string() },
        v2: { request: z.string().refine(async (s) => s.length > 0), response: z.string() },
      },
      transforms: { 'v1->v2': { request: async (s) => s.toUpperCase(), response: 'identity' } },
    });
    const pylon = instance(endpoint).forEndpoint('createUser');
    expect((await pylon.processRequest({ 'api-version': 'v1' }, '/async', {}, ' ada ')).body).toBe(
      'ADA',
    );
    expect((await pylon.processResponse('v1', 'ADA', {}, [])).body).toBe('ADA');
  });

  it('does not parse current input twice', async () => {
    const refine = vi.fn(() => true);
    const endpoint = defineEndpoint({
      method: 'POST',
      path: '/once',
      contracts: { v2: { request: z.string().refine(refine), response: z.string() } },
    });
    await instance(endpoint).forEndpoint('createUser').processRequest({}, '/once', {}, 'ok');
    expect(refine).toHaveBeenCalledTimes(1);
  });

  it('rejects versions older than endpoint introduction', async () => {
    const pylon = instance({
      method: 'GET',
      path: '/new',
      contracts: { v2: { response: z.string() } },
    }).forRoute('GET', '/new');
    expect((await pylon.processRequest({ 'api-version': 'v1' }, '/new', {})).status).toBe(400);
    expect((await pylon.processRequest({}, '/new', {})).body).toBeUndefined();
  });

  it('selects method and parameterized route, with static paths first', () => {
    const pylon = new Pylon({
      current: 'v2',
      endpoints: {
        user: { method: 'GET', path: '/users/:id', contracts: { v2: {} } },
        me: { method: 'GET', path: '/users/me', contracts: { v2: {} } },
      },
    });
    expect(pylon.forRoute('GET', '/users/123?x=1')).toBe(pylon.forEndpoint('user'));
    expect(pylon.forRoute('GET', '/users/me/')).toBe(pylon.forEndpoint('me'));
    expect(pylon.forRoute('POST', '/users/me')).toBe(pylon);
    expect(() => pylon.forEndpoint('missing')).toThrow('Unknown Pylon endpoint');
  });

  it.each([
    204, 205, 304, 409, 500,
  ])('preserves bodyless and non-success responses (%i)', async (status) => {
    const body = { error: 'conflict' };
    const result = await instance()
      .forEndpoint('createUser')
      .processResponse('v1', body, {}, [], undefined, status);
    expect(result.body).toBe(body);
  });

  it.each([
    [{ transforms: {} }, 'Missing request migration'],
    [{ transforms: { 'v1->v2': { request: 'identity' } } }, 'Missing response migration'],
    [{ contracts: { v1: createUser.contracts.v1 } }, 'Missing contract for current'],
    [{ transforms: { 'v2->v1': { request: 'identity', response: 'identity' } } }, 'forward order'],
    [
      { transforms: { 'v0->v2': { request: 'identity', response: 'identity' } } },
      'declared contracts',
    ],
    [{ contracts: { v1: { request: {} }, v2: createUser.contracts.v2 } }, 'must be a Zod schema'],
  ])('rejects broken contracts at startup: %j', (override, message) => {
    expect(() => instance({ ...createUser, ...override } as EndpointConfig)).toThrow(message);
  });

  it('rejects missing contracts for an intermediate release', () => {
    expect(
      () =>
        new Pylon({
          current: 'v3',
          versions: ['v1', 'v2', 'v3'],
          endpoints: { users: { method: 'GET', path: '/users', contracts: { v1: {}, v3: {} } } },
        }),
    ).toThrow('Missing contract for version "v2"');
  });

  it('registers only explicitly published date releases', () => {
    const pylon = new Pylon({
      current: '2026-10-08',
      versions: ['2026-01-01', '2026-10-08'],
      endpoints: {
        users: {
          method: 'GET',
          path: '/users',
          contracts: { '2026-01-01': {}, '2026-10-08': {} },
          transforms: { '2026-01-01->2026-10-08': { request: 'identity', response: 'identity' } },
        },
      },
    });
    expect(pylon.normalizer.isValid('2026-01-02')).toBe(false);
  });
});

// Compiler regressions: these calls must stay invalid, even when runtime fixtures pass.
function invalidDefinitions() {
  defineEndpoint({
    method: 'POST',
    path: '/users',
    contracts: createUser.contracts,
    transforms: {
      // @ts-expect-error Unknown version names are not migration keys.
      'v0->v2': { request: 'identity', response: 'identity' },
    },
  });
  defineEndpoint({
    method: 'POST',
    path: '/users',
    contracts: createUser.contracts,
    transforms: {
      'v1->v2': {
        // @ts-expect-error Request output must satisfy the next request schema.
        request: (input) => ({ fullName: input.name.length }),
        response: (output) => ({ id: output.id, name: output.fullName }),
      },
    },
  });
}
void invalidDefinitions;
