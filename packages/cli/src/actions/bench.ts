import type { PylonConfig } from '@ossl/pylon-core';
import { TransformEngine, VersionNormalizer } from '@ossl/pylon-core';
import { loadPylonConfig } from '../load-config.js';

/**
 * Options for the bench command.
 */
export interface BenchOptions {
  /** Number of transform iterations to run */
  iterations: number;
}

/**
 * Result of a single benchmark run.
 */
interface BenchSample {
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Benchmark transform performance between two versions.
 *
 * Loads the pylon config, creates a TransformEngine, and runs the
 * transforms repeatedly to measure average, median, and p99 latency
 * as well as throughput in operations per second.
 */
export async function benchAction(
  source: string,
  target: string,
  options: { iterations?: string | number },
): Promise<void> {
  const { config } = await loadPylonConfig();

  const iterations =
    typeof options.iterations === 'number'
      ? options.iterations
      : parseInt(options.iterations ?? '1000', 10) || 1000;

  const normalizer = new VersionNormalizer(config.versions, config.current);
  const engine = new TransformEngine(config.transforms, config.schemas, normalizer);

  // Build the transform chain to validate it exists
  try {
    engine.buildChain(source, target);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Cannot benchmark: ${message}`);
    process.exit(1);
  }

  // Compile the transform function
  const transformFn = engine.compile(source, target, 'request');

  const testData = createTestPayload(config);

  console.error(`Running ${iterations} iterations: ${source} -> ${target} (request direction)`);
  console.error('');

  // Warmup (10 iterations, no measurement)
  for (let i = 0; i < 10; i++) {
    await transformFn(testData);
  }

  // Benchmark
  const samples: BenchSample[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await transformFn(testData);
    const end = performance.now();
    samples.push({ durationMs: end - start });
  }

  // Calculate statistics
  const durations = samples.map((s) => s.durationMs);
  const sorted = [...durations].sort((a, b) => a - b);

  const total = sorted.reduce((sum, d) => sum + d, 0);
  const avg = total / sorted.length;
  const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1] ?? 0;
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const opsPerSec = 1000 / avg;

  // Print report
  const separator = '─'.repeat(45);
  console.log(separator);
  console.log('  Transform Benchmark Report');
  console.log(separator);
  console.log('');
  console.log(`  Source:            ${source}`);
  console.log(`  Target:            ${target}`);
  console.log(`  Direction:         request`);
  console.log(`  Iterations:        ${iterations.toLocaleString()}`);
  console.log('');
  console.log(`  Avg duration:      ${avg.toFixed(3)} ms`);
  console.log(`  Med duration:      ${med.toFixed(3)} ms`);
  console.log(`  P99 duration:      ${p99.toFixed(3)} ms`);
  console.log(`  Min duration:      ${min.toFixed(3)} ms`);
  console.log(`  Max duration:      ${max.toFixed(3)} ms`);
  console.log(`  Throughput:        ${opsPerSec.toFixed(1)} ops/sec`);
  console.log('');
  console.log(separator);
}

/**
 * Create a test payload for benchmarking.
 *
 * Generates a plausible payload based on the schemas, or a default
 * generic payload if no schemas are defined.
 */
export function createTestPayload(config: PylonConfig): Record<string, unknown> {
  // Try to infer payload shape from schemas
  const schemaKeys = Object.keys(config.schemas);
  if (schemaKeys.length > 0) {
    // Generate a generic payload
    const payload: Record<string, unknown> = {};
    for (const key of schemaKeys) {
      payload[key] = 'test_value';
    }
    return payload;
  }

  // Default payload
  return {
    id: 'test-123',
    name: 'test',
    email: 'test@example.com',
    age: 30,
    active: true,
    tags: ['a', 'b', 'c'],
    metadata: {
      source: 'benchmark',
      timestamp: new Date().toISOString(),
    },
  };
}
