import type { Pylon } from '@ossl/pylon-core';

/**
 * Assertions to run on a transform pair.
 *
 * At least one assertion flag should be set, and `sampleInput` is required
 * when either `noDataLoss` or `reversible` is `true`.
 */
export interface ContractAssertion {
  /**
   * Sample data to feed through the transform for running assertions.
   * Required when `noDataLoss` or `reversible` is `true`.
   */
  sampleInput?: any;

  /**
   * Check that every top-level field present in the original data
   * maps to some field in the transformed output (no data loss).
   *
   * This applies the **request** (upgrade) direction of the transform
   * and compares the key sets of the input and output.
   */
  noDataLoss?: boolean;

  /**
   * Check that the transform is reversible:
   * `response(request(input)) === input`.
   *
   * Requires both the `request` and `response` functions to be defined
   * on the transform pair.
   */
  reversible?: boolean;

  /**
   * Custom assertion function.
   *
   * Called once per defined direction if a `sampleInput` is provided.
   *
   * @param transformed - The output of the transform
   * @param original - The original input to the transform
   * @param direction - Which direction was tested (`'request'` or `'response'`)
   * @returns `true` if the assertion passes, `false` to trigger a failure
   */
  check?: (transformed: any, original: any, direction: string) => boolean | Promise<boolean>;
}

/**
 * Parse a transform key of the form `"source->target"`.
 *
 * @returns `[source, target]` or throws on invalid format.
 */
function parseTransformKey(key: string): [string, string] {
  const parts = key.split('->');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid transform key: "${key}". Expected format: "source->target" (e.g. "v2->v3").`,
    );
  }
  return [parts[0], parts[1]];
}

/**
 * Assert properties of a transform pair — no data loss, reversibility,
 * or custom checks.
 *
 * Throws a descriptive `Error` on the first failing assertion.
 *
 * @example
 * ```ts
 * // Ensure v2->v3 request transform preserves all data
 * await assertContract(pylon, 'v2->v3', {
 *   sampleInput: { first_name: 'Jane', last_name: 'Doe' },
 *   noDataLoss: true,
 *   reversible: false,
 * });
 * ```
 *
 * @example
 * ```ts
 * // Full round-trip integrity check
 * await assertContract(pylon, 'v2->v3', {
 *   sampleInput: { first_name: 'Jane', last_name: 'Doe' },
 *   noDataLoss: true,
 *   reversible: true,
 * });
 * ```
 *
 * @param pylon - A configured Pylon instance
 * @param transformKey - Transform key in the form `"source->target"`
 * @param assertions - Assertions to run on the transform pair
 */
export async function assertContract(
  pylon: Pylon,
  transformKey: string,
  assertions: ContractAssertion,
): Promise<void> {
  parseTransformKey(transformKey); // validate format
  const pair = pylon.config.transforms[transformKey];

  if (!pair) {
    throw new Error(
      `assertContract: transform not found for key "${transformKey}". ` +
        `Available keys: ${Object.keys(pylon.config.transforms).join(', ') || '(none)'}`,
    );
  }

  const sample = assertions.sampleInput;

  // ------------------------------------------------------------------
  // noDataLoss assertion
  // ------------------------------------------------------------------
  if (assertions.noDataLoss) {
    if (sample === undefined) {
      throw new Error('assertContract: "sampleInput" is required when "noDataLoss" is true.');
    }

    const fn = pair.request;
    if (!fn) {
      throw new Error(
        `assertContract: cannot check noDataLoss for "${transformKey}" — no "request" function defined on the pair.`,
      );
    }

    const output = await fn(sample);
    if (typeof output !== 'object' || output === null) {
      throw new Error(
        `assertContract: noDataLoss check failed for "${transformKey}" (request). ` +
          `Transform output is not an object (got ${typeof output}).`,
      );
    }

    const inputKeys = Object.keys(sample);
    const outputKeys = Object.keys(output);
    const missingKeys = inputKeys.filter((k) => !outputKeys.includes(k));

    if (missingKeys.length > 0) {
      throw new Error(
        `assertContract: noDataLoss check FAILED for "${transformKey}" (request). ` +
          `The following keys from the input are missing in the output: ` +
          `[${missingKeys.join(', ')}].`,
      );
    }
  }

  // ------------------------------------------------------------------
  // reversible assertion
  // ------------------------------------------------------------------
  if (assertions.reversible) {
    if (sample === undefined) {
      throw new Error('assertContract: "sampleInput" is required when "reversible" is true.');
    }

    if (!pair.request) {
      throw new Error(
        `assertContract: cannot check reversible for "${transformKey}" — no "request" function defined on the pair.`,
      );
    }
    if (!pair.response) {
      throw new Error(
        `assertContract: cannot check reversible for "${transformKey}" — no "response" function defined on the pair.`,
      );
    }

    const forward = await pair.request(sample);
    const backward = await pair.response(forward);

    try {
      assertDeepEqual(backward, sample);
    } catch {
      // For a more descriptive message, include the actual values
      throw new Error(
        `assertContract: reversible check FAILED for "${transformKey}". ` +
          `Round-trip (request then response) did not return the original input.\n` +
          `  original:  ${JSON.stringify(sample)}\n` +
          `  round-trip: ${JSON.stringify(backward)}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // custom check assertion
  // ------------------------------------------------------------------
  if (assertions.check) {
    if (sample === undefined) {
      throw new Error(
        'assertContract: "sampleInput" is required when a custom "check" function is provided.',
      );
    }

    const directions: Array<'request' | 'response'> = [];
    if (pair.request) directions.push('request');
    if (pair.response) directions.push('response');

    for (const dir of directions) {
      const fn = pair[dir]!;
      const input = dir === 'response' && pair.request ? await pair.request(sample) : sample;
      const transformed = await fn(input);
      const passed = await assertions.check(transformed, sample, dir);

      if (!passed) {
        throw new Error(`assertContract: custom check FAILED for "${transformKey}" (${dir}).`);
      }
    }
  }
}

function assertDeepEqual(actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) return;
  if (
    typeof actual !== 'object' ||
    actual === null ||
    typeof expected !== 'object' ||
    expected === null ||
    Array.isArray(actual) !== Array.isArray(expected)
  ) {
    throw new Error('Values are not deeply equal');
  }
  const keys = Object.keys(actual);
  if (keys.length !== Object.keys(expected).length) throw new Error('Values are not deeply equal');
  for (const key of keys) {
    if (!Object.hasOwn(expected, key)) throw new Error('Values are not deeply equal');
    assertDeepEqual(
      (actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key],
    );
  }
}
