import type { Pylon, TransformResult } from '@ossl/pylon-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookRegistration } from './index.js';
import { PylonWebhook, RegistrationStore } from './index.js';

const URL_A = 'https://example.com/hooks/a';
const URL_B = 'https://example.com/hooks/b';

const transformMock =
  vi.fn<
    (source: string, target: string, direction: string, data: any) => Promise<TransformResult>
  >();

transformMock.mockImplementation(async (source, target, _direction, data) => ({
  status: 'success' as const,
  data: { ...data, transformed: true, from: source, to: target },
}));

const fakePylon = { current: 'v2', transform: transformMock } as unknown as Pylon;

const fetchMock = vi.fn<(input: any, init?: any) => Promise<Response>>();

let webhooks: PylonWebhook;
let store: RegistrationStore;

function register(overrides: Partial<WebhookRegistration> = {}): string {
  return webhooks.register({
    url: URL_A,
    events: ['user.created'],
    version: 'v1',
    ...overrides,
  });
}

function sentBodies(): any[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
}

beforeEach(() => {
  transformMock.mockReset();
  transformMock.mockImplementation(async (source, target, _direction, data) => ({
    status: 'success' as const,
    data: { ...data, transformed: true, from: source, to: target },
  }));
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  store = new RegistrationStore();
  webhooks = new PylonWebhook(fakePylon, store);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('register', () => {
  it('returns a string id', () => {
    const id = register();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns a unique id per registration', () => {
    const id1 = register();
    const id2 = register();
    expect(id1).not.toBe(id2);
  });

  it('stores the registration', () => {
    const id = register({ url: URL_B, events: ['user.created', 'user.updated'], version: 'v2' });
    expect(store.get(id)).toEqual({
      url: URL_B,
      events: ['user.created', 'user.updated'],
      version: 'v2',
    });
  });
});

describe('unregister', () => {
  it('returns true for an existing id', () => {
    const id = register();
    expect(webhooks.unregister(id)).toBe(true);
    expect(store.get(id)).toBeUndefined();
  });

  it('returns false for a non-existent id', () => {
    expect(webhooks.unregister('does-not-exist')).toBe(false);
  });

  it('cleans up migration state', async () => {
    const id = register({ version: 'v1' });
    webhooks.migrateRegistration(id, 'v2', 60_000);

    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Re-register the same id directly in the store to observe whether
    // the migration state survived the unregister.
    webhooks.unregister(id);
    store.register(id, { url: URL_A, events: ['user.created'], version: 'v2' });
    fetchMock.mockClear();

    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].version).toBe('v2');
  });
});

describe('send', () => {
  it('delivers to registrations matching the event', async () => {
    register({ events: ['user.created'], version: 'v2' });
    register({ url: URL_B, events: ['user.created'], version: 'v2' });
    register({ url: URL_B, events: ['user.updated'], version: 'v2' });

    const results = await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([URL_A, URL_B]);
    expect(fetchMock.mock.calls.every((call) => call[1].method === 'POST')).toBe(true);
    expect(
      fetchMock.mock.calls.every((call) => call[1].headers['X-Webhook-Event'] === 'user.created'),
    ).toBe(true);
  });

  it('transforms the payload for non-current versions', async () => {
    register({ version: 'v1' });
    register({ url: URL_B, version: 'v2' });
    const payload = { name: 'Ada', email: 'ada@test.com' };

    await webhooks.send({ event: 'user.created', payload });

    expect(transformMock).toHaveBeenCalledTimes(1);
    expect(transformMock).toHaveBeenCalledWith('v2', 'v1', 'response', payload);

    const bodies = sentBodies();
    expect(bodies.map((b) => b.version)).toEqual(['v1', 'v2']);
    expect(bodies[0].payload).toEqual({ ...payload, transformed: true, from: 'v2', to: 'v1' });
    expect(bodies[1].payload).toEqual(payload);
  });

  it('does not transform when the registration version is current', async () => {
    register({ version: 'v2' });

    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(transformMock).not.toHaveBeenCalled();
    expect(sentBodies()[0].payload).toEqual({ name: 'Ada' });
  });

  it('records history on successful delivery', async () => {
    register({ version: 'v1' });
    const payload = { name: 'Ada' };
    await webhooks.send({ event: 'user.created', payload });

    const history = webhooks.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.event).toBe('user.created');
    expect(history[0]?.version).toBe('v1');
    expect(history[0]?.payload).toEqual({ ...payload, transformed: true, from: 'v2', to: 'v1' });
    expect(webhooks.getHistory(history[0]?.id)).toEqual([history[0]]);
    expect(webhooks.getHistory('missing')).toEqual([]);
  });

  it('returns status 0 when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    register({ version: 'v2' });

    const results = await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe(0);
    expect(typeof results[0]?.idempotencyKey).toBe('string');
    expect(results[0]?.timestamp).toBeInstanceOf(Date);
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
    // Failed deliveries are still recorded in history
    expect(webhooks.getHistory()).toHaveLength(1);
  });

  it('returns status 0 when the transform fails', async () => {
    transformMock.mockResolvedValueOnce({ status: 'error' as const, data: undefined });
    register({ version: 'v1' });

    const results = await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delivers to both old and new versions during the grace period', async () => {
    const id = register({ version: 'v1' });
    webhooks.migrateRegistration(id, 'v2', 60_000);

    const results = await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBodies().map((b) => b.version)).toEqual(['v1', 'v2']);
  });

  it('delivers only to the new version after the grace period expires', async () => {
    vi.useFakeTimers();
    const id = register({ version: 'v1' });
    webhooks.migrateRegistration(id, 'v2', 1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    const results = await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].version).toBe('v2');
  });

  it('includes the signature and custom headers on the request', async () => {
    register({ version: 'v2', secret: 's3cret', headers: { 'X-Custom': 'custom-value' } });

    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    const headers = fetchMock.mock.calls[0]?.[1].headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Webhook-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['X-Custom']).toBe('custom-value');
  });
});

describe('migrateRegistration', () => {
  it('updates the registration version', async () => {
    const id = register({ version: 'v1' });
    webhooks.migrateRegistration(id, 'v3');

    expect(store.get(id)?.version).toBe('v3');
    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = sentBodies()[0];
    expect(body.version).toBe('v3');
    expect(body.payload).toEqual({ name: 'Ada', transformed: true, from: 'v2', to: 'v3' });
  });

  it('sets up dual delivery when a grace period is given', async () => {
    const id = register({ version: 'v1' });
    webhooks.migrateRegistration(id, 'v2', 60_000);

    expect(store.get(id)?.version).toBe('v2');
    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(sentBodies().map((b) => b.version)).toEqual(['v1', 'v2']);
  });

  it('does not set up dual delivery for a zero grace period', async () => {
    const id = register({ version: 'v1' });
    webhooks.migrateRegistration(id, 'v2', 0);

    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].version).toBe('v2');
  });

  it('throws for an unknown id', () => {
    expect(() => webhooks.migrateRegistration('missing', 'v2')).toThrow(/not found/);
  });
});

describe('replay', () => {
  it('delivers a historical event to current registrations', async () => {
    const originalId = register({ version: 'v1' });
    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });

    const [event] = webhooks.getHistory();
    expect(event).toBeDefined();
    if (!event) throw new Error('Missing webhook history');

    webhooks.unregister(originalId);
    const currentId = register({ url: URL_B, version: 'v2' });

    // Clear fetch calls from the initial send so we only count replay deliveries
    fetchMock.mockClear();

    const results = await webhooks.replay(event.id, 'v1');

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(URL_B);

    const body = sentBodies()[0];
    expect(body.event).toBe('user.created');
    expect(body.version).toBe('v1');
    expect(body.payload).toEqual({ name: 'Ada', transformed: true, from: 'v2', to: 'v1' });
    expect(transformMock).toHaveBeenCalledWith(
      'v2',
      'v1',
      'response',
      expect.objectContaining({ name: 'Ada' }),
    );
    expect(store.get(currentId)).toBeDefined();
  });

  it('replays without transforming when the target version is current', async () => {
    register({ version: 'v2' });
    await webhooks.send({ event: 'user.created', payload: { name: 'Ada' } });
    const [event] = webhooks.getHistory();
    if (!event) throw new Error('Missing webhook history');

    const results = await webhooks.replay(event.id, 'v2');

    expect(results).toHaveLength(1);
    expect(sentBodies()[0].payload).toEqual({ name: 'Ada' });
  });

  it('throws for an unknown event id', async () => {
    await expect(webhooks.replay('missing-event', 'v2')).rejects.toThrow(/not found/);
  });
});

it('replays the original current-version payload even after a lossy downgrade', async () => {
  transformMock.mockImplementation(async (_source, target, _direction, data) => ({
    status: 'success',
    data: target === 'v1' ? { name: data.fullName } : data,
  }));
  register({ version: 'v1' });
  const payload = { fullName: 'Ada', email: 'ada@example.com' };
  await webhooks.send({ event: 'user.created', payload });
  const event = webhooks.getHistory()[0];
  if (!event) throw new Error('Missing webhook history');
  expect(event.payload).toEqual({ name: 'Ada' });
  payload.email = 'changed@example.com';
  fetchMock.mockClear();
  await webhooks.replay(event.id, 'v2');
  expect(sentBodies()[0].payload).toEqual({ fullName: 'Ada', email: 'ada@example.com' });
});

it('bounds replay history and evicts the oldest deliveries', async () => {
  webhooks = new PylonWebhook(fakePylon, store, { historyLimit: 1 });
  register({ version: 'v2' });
  await webhooks.send({ event: 'user.created', payload: { name: 'first' } });
  const first = webhooks.getHistory()[0];
  if (!first) throw new Error('Missing webhook history');
  await webhooks.send({ event: 'user.created', payload: { name: 'second' } });
  expect(webhooks.getHistory()).toHaveLength(1);
  expect(webhooks.getHistory()[0]?.payload).toEqual({ name: 'second' });
  await expect(webhooks.replay(first.id, 'v2')).rejects.toThrow('not found');
});
