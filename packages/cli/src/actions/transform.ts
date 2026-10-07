import { TransformEngine, VersionNormalizer } from '@ossl/pylon-core';
import { loadPylonConfig } from '../load-config.js';

/**
 * Show a composed transform chain for a given transform key (e.g., "v1->v2").
 *
 * Looks up the transform pair for the given key and prints its
 * composed form. Shows the chain of transforms that would be applied.
 */
export async function transformShowAction(key: string): Promise<void> {
  const { config } = await loadPylonConfig();

  // Parse the key
  const parts = key.split('->');
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    console.error('Invalid transform key format. Use "source->target" (e.g., "v1->v2").');
    process.exit(1);
  }

  const source = parts[0].trim();
  const target = parts[1].trim();

  const normalizer = new VersionNormalizer(config.versions, config.current);
  const engine = new TransformEngine(config.transforms, config.schemas, normalizer);

  try {
    const chain = engine.buildChain(source, target);

    console.log(`Transform chain: ${source} -> ${target}`);
    console.log('');

    if (chain.length === 0) {
      console.log('  (No transforms needed — same version)');
      return;
    }

    console.log('  Chain:');
    for (const step of chain) {
      console.log(`    ${step}`);
    }
    console.log('');

    // Show request transform
    const requestFn = engine.compile(source, target, 'request');
    console.log('  Request transform:');
    console.log(`    Source → Target: ${source} -> ${target}`);
    console.log(`    Type:            ${requestFn.length > 0 ? 'Custom' : 'Identity'}`);
    console.log('');

    // Show response transform
    const responseFn = engine.compile(target, source, 'response');
    console.log('  Response transform:');
    console.log(`    Target → Source: ${target} -> ${source}`);
    console.log(`    Type:            ${responseFn.length > 0 ? 'Custom' : 'Identity'}`);
    console.log('');

    // Show transform pair details
    const pair = config.transforms[key];
    if (pair) {
      console.log('  Transform pair:');
      console.log(
        `    Request:  ${typeof pair.request === 'function' ? '✓ Defined' : 'Not defined'}`,
      );
      console.log(
        `    Response: ${typeof pair.response === 'function' ? '✓ Defined' : 'Not defined'}`,
      );
      if (pair.onError) {
        console.log(`    Error strategy: ${pair.onError.strategy}`);
        if (pair.onError.errorCode) {
          console.log(`    Error code:     ${pair.onError.errorCode}`);
        }
      } else {
        console.log('    Error strategy: Default (re-throw)');
      }
    } else {
      console.log('  Transform pair: Not defined (identity transform will be used)');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/**
 * Show the version graph as a directed graph.
 *
 * Renders all versions as nodes and registered transforms as edges,
 * showing which version-to-version transitions are supported.
 */
export async function transformGraphAction(): Promise<void> {
  const { config } = await loadPylonConfig();

  const normalizer = new VersionNormalizer(config.versions, config.current);
  const versions = normalizer.listVersions();

  if (versions.length === 0) {
    console.log('No versions defined.');
    return;
  }

  console.log('Version Graph:');
  console.log('');

  // Print versions list
  for (const v of versions) {
    const isCurrent = v.name === config.current;
    const markers: string[] = [];
    if (isCurrent) markers.push('current');
    if (v.deprecated) markers.push('deprecated');

    const tag = markers.length > 0 ? ` (${markers.join(', ')})` : '';
    console.log(`  [${v.order}] ${v.name}${tag}`);
  }

  console.log('');

  // Print edges (transforms)
  const transformKeys = Object.keys(config.transforms);

  if (transformKeys.length === 0) {
    console.log('  No transforms defined.');
    return;
  }

  console.log('  Registered transforms:');
  for (const key of transformKeys) {
    const pair = config.transforms[key];
    const hasRequest = typeof pair?.request === 'function';
    const hasResponse = typeof pair?.response === 'function';

    const dirs: string[] = [];
    if (hasRequest) dirs.push('request');
    if (hasResponse) dirs.push('response');

    console.log(`    ${key}  [${dirs.join(', ')}]`);
  }

  // ASCII graph
  if (versions.length > 1) {
    console.log('');
    console.log('  Dependency graph:');
    const sorted = [...versions].sort((a, b) => a.order - b.order);
    const edges: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i]!;
      const next = sorted[i + 1];
      if (next) {
        const hasEdge = transformKeys.includes(`${v.name}->${next.name}`);
        const marker = hasEdge ? '───>' : ' - - >';
        edges.push(`    ${v.name} ${marker} ${next.name}`);
      }
    }
    for (const edge of edges) {
      console.log(edge);
    }
  }

  console.log('');
  console.log(`  Current version: ${config.current}`);
}

/**
 * Compose and display the full transform chain between source and target.
 *
 * Shows all intermediate steps in the transform pipeline, including
 * which transforms will be applied and in what order.
 */
export async function transformComposeAction(source: string, target: string): Promise<void> {
  const { config } = await loadPylonConfig();

  const normalizer = new VersionNormalizer(config.versions, config.current);
  const engine = new TransformEngine(config.transforms, config.schemas, normalizer);

  try {
    const chain = engine.buildChain(source, target);

    console.log(`Composed transform: ${source} -> ${target}`);
    console.log('');

    if (chain.length === 0) {
      console.log('  Source and target are the same version — identity transform.');
      return;
    }

    console.log(`  Chain length: ${chain.length} hop(s)`);
    console.log('');

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]!;
      const pair = config.transforms[step];
      const hasRequest = typeof pair?.request === 'function';
      const hasResponse = typeof pair?.response === 'function';

      console.log(`  Step ${i + 1}: ${step}`);
      console.log(`    Request:  ${hasRequest ? '✓' : '○'} (identity)`);
      console.log(`    Response: ${hasResponse ? '✓' : '○'} (identity)`);

      if (pair?.onError) {
        console.log(`    On error: ${pair.onError.strategy}`);
      }
      console.log('');
    }

    const sourceOrder = normalizer.normalize(source);
    const targetOrder = normalizer.normalize(target);
    const direction =
      sourceOrder !== null && targetOrder !== null && sourceOrder < targetOrder
        ? 'upgrade (old -> new)'
        : 'downgrade (new -> old)';

    console.log(`  Direction: ${direction}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error composing transform: ${message}`);
    process.exit(1);
  }
}
