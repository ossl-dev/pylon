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
