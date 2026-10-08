export function isJSONContentType(value: string): boolean {
  return /^application\/(?:json|[\w!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(value.trim());
}

/** Preserve repeated Set-Cookie headers while applying Pylon's scalar headers. */
export function mergeResponseHeaders(original: Headers, extra: Record<string, string>): Headers {
  const headers = new Headers(original);
  for (const [key, value] of Object.entries(extra)) {
    if (key.toLowerCase() !== 'set-cookie' || !headers.has('set-cookie')) headers.set(key, value);
  }
  return headers;
}

export interface JSONBodyLimits {
  /** Maximum UTF-8 bytes buffered or emitted per JSON body. Default: 1 MiB. */
  request?: number;
  response?: number;
}

export class BodyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`JSON body exceeds ${limit} bytes`);
    this.name = 'BodyLimitError';
  }
}

export function resolveBodyLimits(limits: JSONBodyLimits = {}): Required<JSONBodyLimits> {
  const resolved = { request: limits.request ?? 1_048_576, response: limits.response ?? 1_048_576 };
  for (const [direction, limit] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error(`bodyLimits.${direction} must be a positive safe integer`);
  }
  return resolved;
}

export function checkJSONBodySize(text: string, limit: number): string {
  if (
    text.length > limit ||
    (text.length * 3 > limit && new TextEncoder().encode(text).byteLength > limit)
  )
    throw new BodyLimitError(limit);
  return text;
}

/** Count actual bytes even when Content-Length is absent or inaccurate. Cancel without waiting on the source. */
export async function readJSONBody(
  message: Request | Response,
  limit: number,
): Promise<{ text: string; value: unknown }> {
  const declared = message.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    void message.body?.cancel().catch(() => {});
    throw new BodyLimitError(limit);
  }
  const reader = message.body?.getReader();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    let partial = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new BodyLimitError(limit);
        partial += decoder.decode(value, { stream: true });
        if (partial.length >= 4096) {
          chunks.push(partial);
          partial = '';
        }
      }
      chunks.push(partial + decoder.decode());
      text = chunks.join('');
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  return { text, value: JSON.parse(text) };
}
