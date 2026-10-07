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
