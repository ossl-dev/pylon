import { Pylon } from '@ossl/pylon-core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assertContract, snapshotVersion, testTransform, timeTravel } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** v1-shaped payloads (name/email) and v2-shaped payloads (fullName/email). */
const V1_REQUEST = { name: 'John Doe', email: 'john@example.com' };
const V1_RESPONSE = { name: 'Jane Doe', email: 'jane@example.com' };
const V2_REQUEST = { fullName: 'John Doe', email: 'john@example.com' };
const V2_RESPONSE = { fullName: 'Jane Doe', email: 'jane@example.com' };

function createTestPylon(): Pylon {
  const v1toV2Req = (r: any) => ({
    fullName: r.name ?? '',
    email: r.email ?? 'unknown@example.com',
  });
  const v2toV1Res = (r: any) => ({ name: r.fullName ?? '', email: r.email ?? '' });
  return new Pylon({
    current: 'v2',
    defaultVersion: 'v2',
    versions: [
      { name: 'v1', order: 1 },
      { name: 'v2', order: 2 },
    ],
    schemas: {
      v1: z.object({ name: z.string(), email: z.string() }),
      v2: z.object({ fullName: z.string(), email: z.string().email() }),
    },
    transforms: { 'v1->v2': { request: v1toV2Req, response: v2toV1Res } },
    versioning: { sources: [{ type: 'header', name: 'X-API-Version' }] },
    debug: { enabled: false },
  });
}

/** Pylon with a caller-supplied transform pair for assertContract tests. */
function pylonWithPair(pair: {
  request?: (input: any) => any;
  response?: (input: any) => any;
}): Pylon {
  return new Pylon({
    current: 'v2',
    defaultVersion: 'v2',
    versions: [
      { name: 'v1', order: 1 },
      { name: 'v2', order: 2 },
    ],
    schemas: {
      v1: z.object({ name: z.string() }),
      v2: z.object({ name: z.string() }),
    },
    transforms: { 'v1->v2': pair },
    versioning: { sources: [{ type: 'header', name: 'X-API-Version' }] },
    debug: { enabled: false },
  });
}

/** Response-like object satisfying the parts of `Response` that tests use. */
function mockResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-version': 'v2',
    ...init.headers,
  };
  return {
    status: init.status ?? 200,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * Mock fetch that inspects the outgoing JSON body to determine which version
 * the request was downgraded to, then replies in that version's shape.
 */
function versionAwareFetchMock() {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const raw = init?.body ? JSON.parse(String(init.body)) : null;
    if (raw !== null && typeof raw === 'object' && 'name' in raw) {
      return mockResponse(V1_RESPONSE);
    }
    return mockResponse(V2_RESPONSE);
  });
}

/** Await a promise that is expected to reject and return the caught error. */
async function captureError(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

// ---------------------------------------------------------------------------
// testTransform
// ---------------------------------------------------------------------------

describe('testTransform', () => {
  it('applies the request direction transform (old -> new)', async () => {
    const pylon = createTestPylon();
    const result = await testTransform(pylon, 'v1->v2', 'request', V1_REQUEST);
    expect(result).toEqual(V2_REQUEST);
  });

  it('applies the response direction transform (new -> old)', async () => {
    const pylon = createTestPylon();
    const result = await testTransform(pylon, 'v1->v2', 'response', V2_REQUEST);
    expect(result).toEqual(V1_REQUEST);
  });

  it('works with async transform functions', async () => {
    const pylon = pylonWithPair({
      request: async (r: any) => ({ name: r.name.toUpperCase() }),
      response: async (r: any) => ({ name: r.name.toLowerCase() }),
    });
    const result = await testTransform(pylon, 'v1->v2', 'request', {
      name: 'john',
    });
    expect(result).toEqual({ name: 'JOHN' });
  });

  it('throws with a useful message when the transform key is not found', async () => {
    const pylon = createTestPylon();
    const err = await captureError(testTransform(pylon, 'v9->v10', 'request', {}));
    expect(err.message).toContain('transform not found for key "v9->v10"');
    expect(err.message).toContain('Available keys: v1->v2');
  });

  it('throws when the transform exists but the direction function is missing', async () => {
    const pylon = pylonWithPair({ request: (r: any) => r });
    const err = await captureError(testTransform(pylon, 'v1->v2', 'response', { name: 'John' }));
    expect(err.message).toContain('transform "v1->v2" does not define a "response" function');
  });
});

// ---------------------------------------------------------------------------
// assertContract
// ---------------------------------------------------------------------------

describe('assertContract', () => {
  it('passes when all assertions pass and the sample input transforms correctly', async () => {
    const pylon = pylonWithPair({
      request: (r: any) => ({ ...r, processed: true }),
      response: (r: any) => {
        const { processed: _processed, ...rest } = r;
        return rest;
      },
    });
    await expect(
      assertContract(pylon, 'v1->v2', {
        sampleInput: { name: 'John', email: 'john@example.com' },
        noDataLoss: true,
        reversible: true,
        check: (transformed, original, direction) => {
          if (direction === 'request') {
            return transformed.processed === true && transformed.name === original.name;
          }
          return transformed.name === original.name;
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('noDataLoss fails when an input key is missing from the output', async () => {
    // The v1->v2 request transform renames `name` to `fullName`, so `name` is lost.
    const pylon = createTestPylon();
    const err = await captureError(
      assertContract(pylon, 'v1->v2', {
        sampleInput: { name: 'John', email: 'john@example.com' },
        noDataLoss: true,
      }),
    );
    expect(err.message).toContain('noDataLoss check FAILED for "v1->v2"');
    expect(err.message).toContain('missing in the output: [name]');
  });

  it('noDataLoss passes when every input key is present in the output', async () => {
    const pylon = pylonWithPair({
      request: (r: any) => ({ ...r, extra: 'added' }),
    });
    await expect(
      assertContract(pylon, 'v1->v2', {
        sampleInput: { name: 'John', email: 'john@example.com' },
        noDataLoss: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('reversible passes when the round-trip returns the original input', async () => {
    const pylon = createTestPylon();
    await expect(
      assertContract(pylon, 'v1->v2', {
        sampleInput: { name: 'John', email: 'john@example.com' },
        reversible: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('reversible fails when the round-trip does not match the original input', async () => {
    const pylon = pylonWithPair({
      request: (r: any) => ({ fullName: r.name, email: r.email }),
      response: () => ({ name: 'WRONG', email: 'wrong@example.com' }),
    });
    const err = await captureError(
      assertContract(pylon, 'v1->v2', {
        sampleInput: { name: 'John', email: 'john@example.com' },
        reversible: true,
      }),
    );
    expect(err.message).toContain('reversible check FAILED for "v1->v2"');
    expect(err.message).toContain(
      'Round-trip (request then response) did not return the original input',
    );
  });

  it('custom check passes when it returns true', async () => {
    const pylon = createTestPylon();
    const check = vi.fn(() => true);
    await expect(
      assertContract(pylon, 'v1->v2', {
        sampleInput: { name: 'John', email: 'john@example.com' },
        check,
      }),
    ).resolves.toBeUndefined();
    // Runs once per defined direction. Arg order: (transformed, original, direction)
    expect(check).toHaveBeenCalledTimes(2);
    // request direction: v1 sample transformed to v2
    expect(check).toHaveBeenCalledWith(
      { fullName: 'John', email: 'john@example.com' },
      { name: 'John', email: 'john@example.com' },
      'request',
    );
    // Response direction consumes the upgraded request.
    expect(check).toHaveBeenCalledWith(
      { name: 'John', email: 'john@example.com' },
      { fullName: 'John', email: 'john@example.com' },
      'response',
    );
  });

  it('custom check fails when it returns false', async () => {
    const pylon = createTestPylon();
    const err = await captureError(
      assertContract(pylon, 'v1->v2', {
        sampleInput: { name: 'John', email: 'john@example.com' },
        check: () => false,
      }),
    );
    expect(err.message).toContain('custom check FAILED for "v1->v2" (request)');
  });

  it('throws when the transform key format is invalid', async () => {
    const pylon = createTestPylon();
    for (const badKey of ['v1v2', '->v2', 'v1->', 'v1->v2->v3']) {
      const err = await captureError(assertContract(pylon, badKey, { sampleInput: {} }));
      expect(err.message).toContain('Invalid transform key');
    }
  });

  it('throws when the transform key is valid but the transform is missing', async () => {
    const pylon = createTestPylon();
    const err = await captureError(assertContract(pylon, 'v2->v3', { sampleInput: {} }));
    expect(err.message).toContain('transform not found for key "v2->v3"');
  });
});

// ---------------------------------------------------------------------------
// timeTravel
// ---------------------------------------------------------------------------

describe('timeTravel', () => {
  it('calls the callback once per version with the version name and a request helper', async () => {
    const pylon = createTestPylon();
    const fetchMock = vi.fn(async () => mockResponse(V1_RESPONSE));
    const seen: string[] = [];
    const bodies: unknown[] = [];

    await timeTravel(
      pylon,
      async (version, request) => {
        seen.push(version);
        expect(typeof request).toBe('function');
        const res = await request('GET', '/users');
        bodies.push(res.body);
        expect(res.status).toBe(200);
        expect(res.headers['x-api-version']).toBe('v2');
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(seen).toEqual(['v1', 'v2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Each response retains its original wire format.
    expect(bodies).toEqual([V1_RESPONSE, V1_RESPONSE]);
  });

  it('filters versions when options.versions is provided', async () => {
    const pylon = createTestPylon();
    const seen: string[] = [];

    await timeTravel(
      pylon,
      async (version, request) => {
        seen.push(version);
        await request('GET', '/users');
      },
      { versions: ['v1'], fetch: versionAwareFetchMock() as unknown as typeof fetch },
    );

    expect(seen).toEqual(['v1']);
  });

  it('uses the provided fetch implementation instead of global fetch', async () => {
    const pylon = createTestPylon();
    const fetchMock = vi.fn(async () => mockResponse(V1_RESPONSE));

    await timeTravel(
      pylon,
      async (_version, request) => {
        await request('GET', '/users');
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/users',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-api-version': 'v1' }),
      }),
    );
  });

  it('rejects unknown versions before running callbacks', async () => {
    await expect(
      timeTravel(createTestPylon(), async () => {}, { versions: ['v99'] }),
    ).rejects.toThrow('Unknown test version');
  });

  it('uses options.baseUrl when building request URLs', async () => {
    const pylon = createTestPylon();
    const fetchMock = versionAwareFetchMock();

    await timeTravel(
      pylon,
      async (_version, request) => {
        await request('GET', '/users');
      },
      {
        baseUrl: 'http://example.com:4000',
        fetch: fetchMock as unknown as typeof fetch,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://example.com:4000/users',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends version fixtures and preserves wire responses', async () => {
    const pylon = createTestPylon();
    const fetchMock = versionAwareFetchMock();

    await timeTravel(
      pylon,
      async (version, request) => {
        const res = await request('POST', '/users', {
          body: version === 'v1' ? V1_REQUEST : V2_REQUEST,
        });
        expect(res.body).toEqual(version === 'v1' ? V1_RESPONSE : V2_RESPONSE);
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    const requestBodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body ?? '')),
    );
    // v1 call: explicit historical fixture.
    expect(requestBodies[0]).toEqual(V1_REQUEST);
    // v2 call: the current-version body is sent as-is
    expect(requestBodies[1]).toEqual(V2_REQUEST);
  });

  it('appends query parameters to the request URL', async () => {
    const pylon = createTestPylon();
    const fetchMock = versionAwareFetchMock();

    await timeTravel(
      pylon,
      async (_version, request) => {
        await request('GET', '/users', { query: { page: '2', sort: 'asc' } });
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/users?page=2&sort=asc',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

// ---------------------------------------------------------------------------
// snapshotVersion
// ---------------------------------------------------------------------------

describe('snapshotVersion', () => {
  it('returns an array of { version, data } for each version', async () => {
    const pylon = createTestPylon();
    const fetchMock = versionAwareFetchMock();

    const snapshots = await snapshotVersion(
      pylon,
      async (request, version) => {
        const res = await request('POST', '/users', {
          body: version === 'v1' ? V1_REQUEST : V2_REQUEST,
        });
        return res.body;
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.version)).toEqual(['v1', 'v2']);
    expect(snapshots.map((snapshot) => snapshot.data)).toEqual([V1_RESPONSE, V2_RESPONSE]);
  });

  it('uses the fetcher return value as the snapshot data', async () => {
    const pylon = createTestPylon();
    const fetchMock = vi.fn(async () => mockResponse(V1_RESPONSE));

    const snapshots = await snapshotVersion(
      pylon,
      async (request) => {
        const res = await request('GET', '/users');
        return { status: res.status, body: res.body };
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    // Snapshots preserve the actual response for each version.
    expect(snapshots[0]).toEqual({
      version: 'v1',
      data: { status: 200, body: V1_RESPONSE },
    });
    // Current response also stays unchanged.
    expect(snapshots[1]).toEqual({
      version: 'v2',
      data: { status: 200, body: V1_RESPONSE },
    });
  });

  it('filters versions when options.versions is provided', async () => {
    const pylon = createTestPylon();
    const fetchMock = vi.fn(async () => mockResponse(V1_RESPONSE));

    const snapshots = await snapshotVersion(
      pylon,
      async (request) => {
        const res = await request('GET', '/users');
        return res.body;
      },
      { versions: ['v2'], fetch: fetchMock as unknown as typeof fetch },
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.version).toBe('v2');
  });
});

it('timeTravel sends the selected version on each HTTP request', async () => {
  const pylon = createTestPylon();
  const fetchMock = versionAwareFetchMock();
  await timeTravel(
    pylon,
    async (_version, request) => {
      await request('GET', '/users');
    },
    { fetch: fetchMock as typeof fetch },
  );
  const versions = fetchMock.mock.calls.map((call) =>
    new Headers(call[1]?.headers).get('x-api-version'),
  );
  expect(versions).toEqual(['v1', 'v2']);
});

it('contract reversibility ignores object key insertion order', async () => {
  const pylon = pylonWithPair({
    request: (input) => input,
    response: (input) => ({ email: input.email, name: input.name }),
  });
  await expect(
    assertContract(pylon, 'v1->v2', {
      sampleInput: { name: 'Ada', email: 'ada@example.com' },
      reversible: true,
    }),
  ).resolves.toBeUndefined();
});
