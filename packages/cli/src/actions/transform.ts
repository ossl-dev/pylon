import { readFileSync } from 'node:fs';
import {
  Pylon,
  type TransformDirection,
  TransformError,
  type TransformPair,
} from '@ossl/pylon-core';
import { loadPylonConfig } from '../load-config.js';

export interface TransformOptions {
  endpoint?: string;
  json?: boolean;
  direction?: TransformDirection;
  input?: string;
}

async function loadScope(endpoint?: string): Promise<Pylon> {
  const { config } = await loadPylonConfig();
  const pylon = new Pylon(config);
  if (!endpoint && !pylon.hasPipeline) throw new Error('Select a contract with --endpoint <name>');
  return endpoint ? pylon.forEndpoint(endpoint) : pylon;
}
function mode(fn: TransformPair['request']): string {
  return typeof fn === 'function' ? 'custom' : fn === 'identity' ? 'identity' : 'implicit identity';
}
function describePair(pylon: Pylon, key: string) {
  const pair = pylon.config.transforms[key];
  return {
    key,
    request: mode(pair?.request),
    response: mode(pair?.response),
    onError: pair?.onError?.strategy ?? 'reject',
  };
}
function print(report: unknown, json?: boolean): void {
  console.log(json ? JSON.stringify(report, null, 2) : report);
}

export async function transformShowAction(
  key: string,
  options: TransformOptions = {},
): Promise<void> {
  const parts = key.split('->').map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new Error('Use "source->target" (e.g., "v1->v2").');
  await transformComposeAction(parts[0], parts[1], options);
}

export async function transformComposeAction(
  source: string,
  target: string,
  options: TransformOptions = {},
): Promise<void> {
  const pylon = await loadScope(options.endpoint);
  source = pylon.normalizer.resolveAlias(source);
  target = pylon.normalizer.resolveAlias(target);
  const direction = options.direction ?? 'request';
  if (direction !== 'request' && direction !== 'response')
    throw new Error('Direction must be request or response');
  // Compile validates direction and coverage without executing migrations.
  pylon.engine.compile(source, target, direction);
  const steps = pylon.engine.buildChain(source, target).map((key) => describePair(pylon, key));
  if (options.json) print({ source, target, direction, steps }, true);
  else {
    console.log(`${source} -> ${target} (${direction}, ${steps.length} hops)`);
    for (const step of steps) console.log(`  ${step.key}: ${step[direction]} (${step.onError})`);
  }
}

export async function transformGraphAction(options: TransformOptions = {}): Promise<void> {
  const { config } = await loadPylonConfig();
  const root = new Pylon(config);
  const scopes = options.endpoint
    ? { [options.endpoint]: root.forEndpoint(options.endpoint) }
    : {
        ...(root.hasPipeline ? { global: root } : {}),
        ...Object.fromEntries(
          Object.keys(config.endpoints ?? {}).map((name) => [name, root.forEndpoint(name)]),
        ),
      };
  const report = Object.fromEntries(
    Object.entries(scopes).map(([name, pylon]) => [
      name,
      {
        current: pylon.current,
        versions: pylon.normalizer.listVersions().map((version) => ({
          name: version.name,
          deprecated: pylon.isDeprecated(version.name),
          unpublished: pylon.isUnpublished(version.name),
        })),
        steps: Object.keys(pylon.config.transforms).map((key) => describePair(pylon, key)),
      },
    ]),
  );
  if (options.json) print(report, true);
  else
    for (const [name, scope] of Object.entries(report)) {
      console.log(`${name} (current: ${scope.current})`);
      for (const step of scope.steps)
        console.log(`  ${step.key}: request=${step.request}, response=${step.response}`);
    }
}

/** This executes user functions locally; it never invokes a controller or sends an HTTP request. */
export async function transformRunAction(
  source: string,
  target: string,
  options: TransformOptions,
): Promise<void> {
  try {
    if (!options.input) throw new Error('Provide --input <file> with a JSON fixture');
    const direction = options.direction ?? 'request';
    if (direction !== 'request' && direction !== 'response')
      throw new Error('Direction must be request or response');
    const pylon = await loadScope(options.endpoint);
    const report = await pylon.trace(
      source,
      target,
      direction,
      JSON.parse(readFileSync(options.input, 'utf8')),
    );
    if (options.json) print(report, true);
    else {
      for (const step of report.steps)
        console.log(
          `${step.key}: ${step.status} (${step.durationMs.toFixed(3)} ms)\n  input: ${JSON.stringify(step.input)}\n  output: ${JSON.stringify(step.output)}`,
        );
      if (report.result.status === 'error') console.error(report.result.error?.message);
      else console.log(`Result: ${JSON.stringify(report.result.data)}`);
    }
    if (report.result.status === 'error') process.exitCode = 1;
  } catch (error) {
    if (!options.json) throw error;
    print(
      {
        result: {
          status: 'error',
          error: {
            code: error instanceof TransformError ? error.code : 'TRACE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        },
        steps: [],
      },
      true,
    );
    process.exitCode = 1;
  }
}
