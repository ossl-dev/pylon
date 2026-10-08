import type { PylonConfig } from '@ossl/pylon-core';
import { mergeConfigs, Pylon, VersionNormalizer } from '@ossl/pylon-core';
import type { OpenAPISpec } from '@ossl/pylon-openapi';
import { generateOpenAPI, generateOpenAPIVersions, zodToOpenAPISchema } from '@ossl/pylon-openapi';
import { loadPylonConfig } from '../load-config.js';
import { diffSchemas, type SchemaChange } from './diff.js';

/**
 * Generate an OpenAPI specification from the current config.
 *
 * Outputs a JSON OpenAPI spec to stdout or a file.
 */
export async function generateOpenAPIAction(options: {
  output?: string;
  version?: string;
  allVersions?: boolean;
}): Promise<void> {
  const { config } = await loadPylonConfig();
  if (options.allVersions && options.version) throw new Error('Choose --version or --all-versions');
  if (options.allVersions) {
    const specs = generateOpenAPIVersions(new Pylon(config));
    if (!options.output) {
      console.log(JSON.stringify(specs, null, 2));
      return;
    }
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(options.output, { recursive: true });
    for (const [version, spec] of Object.entries(specs))
      writeFileSync(
        join(options.output, `${encodeURIComponent(version)}.json`),
        `${JSON.stringify(spec, null, 2)}\n`,
      );
    console.log(`OpenAPI specs written to ${options.output}`);
    return;
  }

  const spec = generateOpenAPI(
    new Pylon(config),
    options.version ? { versions: [options.version] } : {},
  );

  if (options.output) {
    const { dirname } = await import('node:path');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, JSON.stringify(spec, null, 2), 'utf-8');
    console.log(`OpenAPI spec written to ${options.output}`);
  } else {
    console.log(JSON.stringify(spec, null, 2));
  }
}

/**
 * Generate paths and JSON schemas using the OpenAPI package.
 */
export function buildOpenAPISpec(config: PylonConfig): OpenAPISpec {
  return generateOpenAPI(new Pylon(config));
}

export function extractVersions(config: PylonConfig): string[] {
  return new VersionNormalizer(config.versions, config.current)
    .listVersions()
    .map((version) => version.name);
}

export interface ContractChangelog {
  source: string;
  target: string;
  operations: Array<{
    name: string;
    method?: string;
    path?: string;
    availability?: 'introduced' | 'unavailable';
    request: SchemaChange[];
    response: SchemaChange[];
    migrations: string[];
  }>;
}

export async function generateChangelogAction(
  range: string,
  options: { output?: string; json?: boolean } = {},
): Promise<void> {
  const parts = range.split(/\.{2,3}/).map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new Error('Use "source..target" (e.g., "v1..v2").');
  const { config } = await loadPylonConfig();
  const report = buildChangelogReport(parts[0], parts[1], config);
  const text = options.json ? `${JSON.stringify(report, null, 2)}\n` : renderChangelog(report);
  if (options.output) {
    const { dirname } = await import('node:path');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, text);
    console.log(`Changelog written to ${options.output}`);
  } else console.log(text.trimEnd());
}

/** Compare declared contracts. User migrations are described but never executed. */
export function buildChangelogReport(
  source: string,
  target: string,
  config: PylonConfig,
): ContractChangelog {
  const normalizer = new VersionNormalizer(config.versions, config.current);
  source = normalizer.resolveAlias(source);
  target = normalizer.resolveAlias(target);
  const from = normalizer.normalize(source);
  const to = normalizer.normalize(target);
  if (from === null || to === null) throw new Error('Changelog range must use registered versions');
  const lower = Math.min(from, to);
  const upper = Math.max(from, to);
  const scopes = [
    ...(config.contracts ||
    Object.keys(config.schemas).length ||
    Object.keys(config.transforms).length
      ? [{ name: 'global', config }]
      : []),
    ...Object.entries(config.endpoints ?? {}).map(([name, endpoint]) => ({
      name,
      config: mergeConfigs(config, endpoint),
      method: endpoint.method,
      path: endpoint.path,
    })),
  ];
  const operations: ContractChangelog['operations'] = [];
  for (const scope of scopes) {
    const contracts = scope.config.contracts;
    const before = contracts
      ? contracts[source]
      : scope.config.schemas[source]
        ? { request: scope.config.schemas[source] }
        : undefined;
    const after = contracts
      ? contracts[target]
      : scope.config.schemas[target]
        ? { request: scope.config.schemas[target] }
        : undefined;
    const migrations = Object.keys(scope.config.transforms).filter((key) => {
      const [left, right] = key.split('->');
      const a = normalizer.normalize(left ?? '');
      const b = normalizer.normalize(right ?? '');
      return (
        a !== null && b !== null && a !== b && a >= lower && a <= upper && b >= lower && b <= upper
      );
    });
    if (!before && !after && !migrations.length) continue;
    const compare = (direction: 'request' | 'response') =>
      diffSchemas(
        before?.[direction]
          ? zodToOpenAPISchema(before[direction], direction === 'request' ? 'input' : 'output')
          : undefined,
        after?.[direction]
          ? zodToOpenAPISchema(after[direction], direction === 'request' ? 'input' : 'output')
          : undefined,
      );
    operations.push({
      name: scope.name,
      ...('method' in scope ? { method: scope.method, path: scope.path } : {}),
      ...(!before && after
        ? { availability: 'introduced' as const }
        : before && !after
          ? { availability: 'unavailable' as const }
          : {}),
      request: compare('request'),
      response: compare('response'),
      migrations,
    });
  }
  return { source, target, operations };
}

export function buildChangelog(source: string, target: string, config: PylonConfig): string {
  return renderChangelog(buildChangelogReport(source, target, config));
}

function renderChangelog(report: ContractChangelog): string {
  const lines = [
    `# Contract changes: ${report.source} -> ${report.target}`,
    '',
    'Declared schema changes only. Review behavior and side effects separately.',
    '',
  ];
  for (const operation of report.operations) {
    lines.push(
      `## ${operation.name}${operation.method && operation.path ? ` (${operation.method} ${operation.path})` : ''}`,
      '',
    );
    if (operation.availability)
      lines.push(`Contract ${operation.availability} in ${report.target}.`, '');
    for (const direction of ['request', 'response'] as const) {
      if (!operation[direction].length) continue;
      lines.push(`### ${direction === 'request' ? 'Request' : 'Response'}`, '');
      for (const change of operation[direction])
        lines.push(`- ${change.type}: \`${change.field}\` — ${change.details}`);
      lines.push('');
    }
    if (!operation.request.length && !operation.response.length)
      lines.push('No declared schema changes.', '');
    if (operation.migrations.length)
      lines.push(
        '### Related Transforms',
        '',
        ...operation.migrations.map((key) => `- \`${key}\``),
        '',
      );
  }
  if (!report.operations.length) lines.push('No declared schema changes.', '');
  return `${lines.join('\n').trimEnd()}\n`;
}
