import { readFileSync } from 'node:fs';
import { Pylon } from '@ossl/pylon-core';
import { loadPylonConfig } from '../load-config.js';

export interface BenchmarkResult {
  iterations: number;
  coldMs: number;
  meanMs: number;
  medianMs: number;
  p99Ms: number;
  elapsedMs: number;
  opsPerSecond: number;
}

/** Each operation must create its own fixture if user transforms can mutate input. */
export async function runBenchmark(
  operation: () => unknown | Promise<unknown>,
  iterations = 1000,
): Promise<BenchmarkResult> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000_000)
    throw new Error('Iterations must be an integer between 1 and 1000000');
  const coldStart = performance.now();
  await operation();
  const coldMs = performance.now() - coldStart;
  for (let i = 0; i < Math.min(iterations, 100); i++) await operation();
  const samples = new Float64Array(iterations);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const before = performance.now();
    await operation();
    samples[i] = performance.now() - before;
  }
  const elapsedMs = performance.now() - start;
  let sum = 0;
  for (const sample of samples) sum += sample;
  samples.sort();
  return {
    iterations,
    coldMs,
    meanMs: sum / iterations,
    medianMs:
      (samples[Math.floor((iterations - 1) / 2)]! + samples[Math.floor(iterations / 2)]!) / 2,
    p99Ms: samples[Math.ceil(iterations * 0.99) - 1]!,
    elapsedMs,
    opsPerSecond: (iterations * 1000) / elapsedMs,
  };
}

export interface BenchOptions {
  input: string;
  response?: string;
  endpoint?: string;
  mode?: 'transform' | 'pipeline';
  iterations?: string | number;
  json?: boolean;
}

/** Benchmark real fixtures: parsing, migration, and (pipeline mode) both contract boundaries. */
export async function benchAction(
  source: string,
  target: string,
  options: BenchOptions,
): Promise<void> {
  const mode = options.mode ?? 'transform';
  if (!['transform', 'pipeline'].includes(mode))
    throw new Error('Mode must be transform or pipeline');
  const iterations = Number(options.iterations ?? 1000);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000_000)
    throw new Error('Iterations must be an integer between 1 and 1000000');
  const { config } = await loadPylonConfig();
  const root = new Pylon(config);
  const pylon = options.endpoint ? root.forEndpoint(options.endpoint) : root;
  source = pylon.normalizer.resolveAlias(source);
  target = pylon.normalizer.resolveAlias(target);
  pylon.engine.buildChain(source, target);
  if (mode === 'pipeline' && target !== pylon.current)
    throw new Error('Pipeline benchmark target must be the current version');
  if (mode === 'pipeline' && !options.response)
    throw new Error('Pipeline mode requires --response with a current response fixture');
  const input = readFileSync(options.input, 'utf8');
  JSON.parse(input);
  const response = options.response ? readFileSync(options.response, 'utf8') : undefined;
  if (response !== undefined) JSON.parse(response);
  const operation = async () => {
    if (mode === 'transform') {
      const result = await pylon.transform(source, target, 'request', JSON.parse(input));
      if (result.status === 'error') throw new Error(result.error?.message);
      JSON.stringify(result.data);
    } else {
      const request = await pylon.processRequest({}, '/', {}, JSON.parse(input), {
        version: source,
      });
      if (request.transformResult.status === 'error')
        throw new Error(`Request benchmark failed: ${request.transformResult.error?.message}`);
      const result = await pylon.processResponse(
        request.version,
        JSON.parse(response!),
        request.headers,
        [],
      );
      if (result.status && result.status >= 400)
        throw new Error(`Response benchmark failed: ${JSON.stringify(result.body)}`);
      JSON.stringify(result.body);
    }
  };
  const result = {
    source,
    target,
    endpoint: options.endpoint,
    mode,
    inputBytes: Buffer.byteLength(input),
    responseBytes: response === undefined ? undefined : Buffer.byteLength(response),
    ...(await runBenchmark(operation, iterations)),
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `${source} -> ${target} (${mode}, ${result.inputBytes} input bytes, ${iterations} iterations)`,
    );
    console.log(
      `Cold: ${result.coldMs.toFixed(3)} ms | warm mean: ${result.meanMs.toFixed(3)} ms | median: ${result.medianMs.toFixed(3)} ms | p99: ${result.p99Ms.toFixed(3)} ms`,
    );
    console.log(`Throughput: ${result.opsPerSecond.toFixed(0)} ops/sec`);
  }
}
