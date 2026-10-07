import type { Pylon } from '@ossl/pylon-core';

/**
 * Unit test a single transform pair.
 *
 * Parses the transform key (e.g. `'v2->v3'`), looks up the corresponding
 * `TransformPair` from the pylon config, and calls the function for the
 * given `direction` with the supplied `input`.
 *
 * Both sync and async transform functions are supported; the result is
 * always returned as a Promise.
 *
 * @example
 * ```ts
 * const v2 = { first_name: 'John', last_name: 'Doe' };
 * const v3 = await testTransform(pylon, 'v2->v3', 'request', v2);
 * expect(v3).toEqual({ fullName: 'John Doe' });
 * ```
 *
 * @param pylon - A configured Pylon instance
 * @param transformKey - Transform key in the form `"source->target"`,
 *                       e.g. `"v2->v3"`
 * @param direction - Which direction to test: `'request'` (old -> new) or
 *                    `'response'` (new -> old)
 * @param input - The data to transform
 * @returns The transformed data
 */
export async function testTransform(
  pylon: Pylon,
  transformKey: string,
  direction: 'request' | 'response',
  input: any,
): Promise<any> {
  const pair = pylon.config.transforms[transformKey];
  if (!pair) {
    throw new Error(
      `testTransform: transform not found for key "${transformKey}". ` +
        `Available keys: ${Object.keys(pylon.config.transforms).join(', ') || '(none)'}`,
    );
  }

  const fn = pair[direction];
  if (!fn) {
    throw new Error(
      `testTransform: transform "${transformKey}" does not define a "${direction}" function.`,
    );
  }

  return fn === 'identity' ? input : await fn(input);
}
