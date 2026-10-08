import { describe, expect, it, vi } from 'vitest';
import { BodyLimitError, checkJSONBodySize, readJSONBody, resolveBodyLimits } from './http.js';

function stream(chunks: Uint8Array[], cancel = vi.fn()) {
  let i = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]!);
        else controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
}

describe('bounded JSON bodies', () => {
  it('decodes split UTF-8 sequences and allows the exact byte budget', async () => {
    const bytes = new TextEncoder().encode('"💤"');
    const response = new Response(stream([bytes.slice(0, 3), bytes.slice(3)]));
    expect(await readJSONBody(response, bytes.length)).toEqual({ text: '"💤"', value: '💤' });
  });

  it('counts actual bytes when length is absent, invalid, or too small', async () => {
    for (const length of [undefined, '1', 'junk']) {
      const cancel = vi.fn();
      const response = new Response(
        stream([new TextEncoder().encode('"ab'), new TextEncoder().encode('c"')], cancel),
        {
          headers: length ? { 'content-length': length } : {},
        },
      );
      await expect(readJSONBody(response, 4)).rejects.toBeInstanceOf(BodyLimitError);
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    }
  });

  it('rejects oversized declared bodies before pulling, without waiting for cancellation', async () => {
    const pull = vi.fn();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { 'content-length': '1000' },
    });
    await expect(readJSONBody(response, 4)).rejects.toBeInstanceOf(BodyLimitError);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves source failures and releases stream locks', async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('disconnected'));
        },
      }),
    );
    await expect(readJSONBody(response, 100)).rejects.toThrow('disconnected');
    expect(response.body?.locked).toBe(false);
  });

  it('checks UTF-8 output size and validates budgets at setup', () => {
    expect(checkJSONBodySize('"💤"', 6)).toBe('"💤"');
    expect(() => checkJSONBodySize('"💤"', 5)).toThrow(BodyLimitError);
    expect(resolveBodyLimits()).toEqual({ request: 1_048_576, response: 1_048_576 });
    for (const request of [0, -1, 1.5, NaN, Infinity])
      expect(() => resolveBodyLimits({ request })).toThrow('positive safe integer');
  });
});
