import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineEndpoint } from './contracts.js';
import { Pylon } from './pylon.js';

function strict(transforms?: Record<string, unknown>) {
  return new Pylon({
    current: 'v2',
    versions: ['v1', 'v2'],
    endpoints: {
      users: defineEndpoint({
        method: 'POST',
        path: '/users',
        contracts: {
          v1: { request: z.object({ name: z.string() }), response: z.object({ id: z.number() }) },
          v2: {
            request: z.object({ fullName: z.string(), active: z.boolean().default(true) }),
            response: z.object({ id: z.number(), fullName: z.string() }),
          },
        },
        transforms: transforms ?? {
          'v1->v2': {
            request: (input) => ({ fullName: input.name }),
            response: (output) => ({ id: output.id }),
          },
        },
      }),
    },
  }).forEndpoint('users');
}

describe('migration traces', () => {
  it('executes async and mutating migrations once, with detached snapshots', async () => {
    const first = vi.fn((input) => {
      input.value++;
      return input;
    });
    const second = vi.fn(async (input) => {
      input.value *= 3;
      return input;
    });
    const pylon = new Pylon({
      current: 'v3',
      versions: ['v1', 'v2', 'v3'],
      transforms: {
        'v1->v2': { request: first },
        'v2->v3': { request: second },
      },
    });
    const trace = await pylon.trace('v1', 'v3', 'request', { value: 1 });
    expect(trace.result).toEqual({ status: 'success', data: { value: 6 } });
    expect(trace.steps.map((s) => [s.input, s.output])).toEqual([
      [{ value: 1 }, { value: 2 }],
      [{ value: 2 }, { value: 6 }],
    ]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(trace.steps.every((s) => s.durationMs >= 0)).toBe(true);
    (trace.result.data as { value: number }).value = 10;
    expect(trace.steps[1]?.output).toEqual({ value: 6 });
  });

  it('uses parsed source and target contracts, including defaults and lossy responses', async () => {
    const pylon = strict();
    const request = await pylon.trace('v1', 'v2', 'request', { name: 'Ada', discarded: true });
    expect(request.steps[0]).toMatchObject({
      input: { name: 'Ada' },
      output: { fullName: 'Ada', active: true },
    });
    expect(
      (await pylon.trace('v2', 'v1', 'response', { id: 1, fullName: 'Ada' })).result.data,
    ).toEqual({ id: 1 });
    expect((await pylon.trace('v2', 'v2', 'request', { fullName: 'Ada' })).result.data).toEqual({
      fullName: 'Ada',
      active: true,
    });
  });

  it('captures the failed hop and structured schema issue paths', async () => {
    const trace = await strict({ 'v1->v2': { request: () => ({}), response: 'identity' } }).trace(
      'v1',
      'v2',
      'request',
      { name: 'Ada' },
    );
    expect(trace.result.error?.code).toBe('REQUEST_CONTRACT_FAILED');
    expect(trace.steps[0]).toMatchObject({
      status: 'error',
      error: {
        details: { key: 'v1->v2', issues: [expect.objectContaining({ path: ['fullName'] })] },
      },
    });
    expect((await strict().trace('v1', 'v2', 'request', { name: 1 })).steps).toEqual([]);
  });

  it('captures validated fallback results and preserves fallback schema failures', async () => {
    const fallback = vi.fn(() => ({ fullName: 'fallback' }));
    const pylon = strict({
      'v1->v2': {
        request: () => {
          throw new Error('broken');
        },
        response: 'identity',
        onError: { strategy: 'fallback', fallback },
      },
    });
    const trace = await pylon.trace('v1', 'v2', 'request', { name: 'Ada' });
    expect(trace.steps[0]).toMatchObject({
      status: 'fallback',
      output: { fullName: 'fallback', active: true },
    });
    expect(trace.result.status).toBe('fallback');
    expect(fallback).toHaveBeenCalledOnce();
    const bad = await strict({
      'v1->v2': {
        request: () => {
          throw new Error('broken');
        },
        response: 'identity',
        onError: { strategy: 'fallback', fallback: () => ({}) },
      },
    }).trace('v1', 'v2', 'request', { name: 'Ada' });
    expect(bad.steps[0]).toMatchObject({
      status: 'error',
      error: {
        code: 'FALLBACK_FAILED',
        details: { issues: [expect.objectContaining({ path: ['fullName'] })] },
      },
    });
  });

  it('logs continued failures by default and respects explicit error hooks', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = {
        current: 'v2',
        versions: ['v1', 'v2'],
        transforms: {
          'v1->v2': {
            request: () => {
              throw new Error('continued');
            },
            onError: { strategy: 'log-and-continue' as const },
          },
        },
      };
      expect(
        (await new Pylon(config).processRequest({ 'accept-version': 'v1' }, '/', {}, {})).status,
      ).toBeUndefined();
      expect(log).toHaveBeenCalledOnce();
      const onTransformError = vi.fn();
      await new Pylon({ ...config, onTransformError }).processRequest(
        { 'accept-version': 'v1' },
        '/',
        {},
        {},
      );
      expect(onTransformError).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
});
