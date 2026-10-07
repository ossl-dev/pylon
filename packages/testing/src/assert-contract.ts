import { isDeepStrictEqual } from 'node:util';
import type { Pylon, TransformDirection, TransformPair } from '@ossl/pylon-core';

export interface ContractAssertion {
  sampleInput?: unknown;
  /** Current response fixture, independent of the historical request fixture. */
  sampleResponse?: unknown;
  /** Preserve each top-level input field and its value. Renames require fieldMap. */
  noDataLoss?: boolean;
  fieldMap?: Record<string, string>;
  /** Legacy shape-only checks. Request and response contracts are not inverses. */
  reversible?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: assertion callbacks inspect caller-supplied fixture shapes
  check?: (
    transformed: any,
    original: any,
    direction: TransformDirection,
  ) => boolean | Promise<boolean>;
}

type Migration = NonNullable<TransformPair['request']>;
async function apply(fn: Migration, input: unknown): Promise<unknown> {
  return fn === 'identity' ? input : fn(input);
}

export async function assertContract(
  pylon: Pylon,
  key: string,
  assertions: ContractAssertion,
): Promise<void> {
  if (!/^[^\s]+->[^\s]+$/.test(key) || key.split('->').length !== 2)
    throw new Error(`Invalid transform key: "${key}". Expected format: "source->target".`);
  const pair = pylon.config.transforms[key];
  if (!pair)
    throw new Error(
      `assertContract: transform not found for key "${key}". Available keys: ${Object.keys(pylon.config.transforms).join(', ') || '(none)'}`,
    );
  const sample = assertions.sampleInput;
  const hasSample = Object.hasOwn(assertions, 'sampleInput');
  if ((assertions.noDataLoss || assertions.reversible || assertions.check) && !hasSample)
    throw new Error('assertContract: "sampleInput" is required for these assertions.');
  if (assertions.reversible && pylon.config.contracts)
    throw new Error(
      'Request and response contracts are independent. Use sampleResponse and check instead of reversible.',
    );
  const preserved = assertions.noDataLoss ? structuredClone(sample) : sample;
  const [source, target] = key.split('->') as [string, string];
  const migrate = async (direction: TransformDirection, input: unknown) => {
    const fn = pair[direction];
    if (!fn) return undefined;
    if (!pylon.config.contracts) return apply(fn, input);
    const result = await pylon.transform(
      direction === 'request' ? source : target,
      direction === 'request' ? target : source,
      direction,
      input,
    );
    if (result.status === 'error')
      throw new Error(`assertContract: ${direction} migration failed: ${result.error?.message}`);
    return result.data;
  };
  const forward = pair.request && hasSample ? await migrate('request', sample) : undefined;
  if (assertions.noDataLoss) {
    if (!pair.request)
      throw new Error(
        `assertContract: cannot check noDataLoss for "${key}" — no "request" function defined on the pair.`,
      );
    if (
      typeof sample !== 'object' ||
      sample === null ||
      typeof forward !== 'object' ||
      forward === null
    )
      throw new Error(
        `assertContract: noDataLoss check failed for "${key}" (request). Input and transform output must be objects.`,
      );
    const input = preserved as Record<string, unknown>;
    const output = forward as Record<string, unknown>;
    const fields = new Map(Object.entries(assertions.fieldMap ?? {}));
    const missing = Object.keys(input).filter(
      (field) => !Object.hasOwn(output, fields.get(field) ?? field),
    );
    if (missing.length)
      throw new Error(
        `assertContract: noDataLoss check FAILED for "${key}" (request). The following keys from the input are missing in the output: [${missing.join(', ')}].`,
      );
    for (const field of Object.keys(input)) {
      const target = fields.get(field) ?? field;
      if (!isDeepStrictEqual(input[field], output[target]))
        throw new Error(
          `assertContract: noDataLoss check FAILED for "${key}": value changed for "${field}" -> "${target}".`,
        );
    }
  }
  if (assertions.reversible) {
    if (!pair.request)
      throw new Error(
        `assertContract: cannot check reversible for "${key}" — no "request" function defined on the pair.`,
      );
    if (!pair.response)
      throw new Error(
        `assertContract: cannot check reversible for "${key}" — no "response" function defined on the pair.`,
      );
    if (!isDeepStrictEqual(await apply(pair.response, forward), sample))
      throw new Error(
        `assertContract: reversible check FAILED for "${key}". Round-trip (request then response) did not return the original input.`,
      );
  }
  if (assertions.check) {
    for (const direction of ['request', 'response'] as const) {
      const fn = pair[direction];
      if (!fn) continue;
      if (
        direction === 'response' &&
        pylon.config.contracts &&
        !Object.hasOwn(assertions, 'sampleResponse')
      )
        throw new Error(
          'assertContract: "sampleResponse" is required for response contract checks.',
        );
      const original =
        direction === 'request'
          ? sample
          : Object.hasOwn(assertions, 'sampleResponse')
            ? assertions.sampleResponse
            : pair.request
              ? forward
              : sample;
      const output = direction === 'request' ? forward : await migrate('response', original);
      if (!(await assertions.check(output, original, direction)))
        throw new Error(`assertContract: custom check FAILED for "${key}" (${direction}).`);
    }
  }
}
