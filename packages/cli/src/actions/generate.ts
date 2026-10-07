import type { PylonConfig } from '@ossl/pylon-core';
import { Pylon, VersionNormalizer } from '@ossl/pylon-core';
import type { OpenAPISpec } from '@ossl/pylon-openapi';
import { generateOpenAPI } from '@ossl/pylon-openapi';
import { loadPylonConfig } from '../load-config.js';

/**
 * Generate an OpenAPI specification from the current config.
 *
 * Outputs a JSON OpenAPI spec to stdout or a file.
 */
export async function generateOpenAPIAction(options: { output?: string }): Promise<void> {
  const { config } = await loadPylonConfig();

  const spec = buildOpenAPISpec(config);

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

/**
 * Generate a changelog between version ranges.
 *
 * Accepts a range string in the format "v1..v2" or "v1...v2".
 * Currently a stub that describes the planned functionality.
 */
export async function generateChangelogAction(range: string): Promise<void> {
  const { config } = await loadPylonConfig();

  // Parse the range
  const separator = range.includes('...') ? '...' : '..';
  const parts = range.split(separator);
  const source = parts[0]?.trim();
  const target = parts[1]?.trim();

  if (!source || !target) {
    console.error('Invalid range format. Use "source..target" (e.g., "v1..v2").');
    process.exit(1);
  }

  // Print header
  console.log(`# Changelog: ${source} -> ${target}`);
  console.log('');
  console.log(`Generated from pylon.config.ts`);
  console.log(`Current version: ${config.current}`);
  console.log('');

  // For now, produce a minimal changelog
  const changelog = buildChangelog(source, target, config);
  console.log(changelog);
}

/**
 * Build a changelog string between two versions.
 *
 * Currently produces a template changelog. Full implementation
 * will compare schemas, transforms, and endpoint definitions.
 */
export function buildChangelog(source: string, target: string, config: PylonConfig): string {
  const lines: string[] = [];

  // Check if there are schemas defined
  const schemas = config.schemas;
  const hasSchemas = schemas && typeof schemas === 'object' && Object.keys(schemas).length > 0;

  if (hasSchemas) {
    lines.push('## Schema Changes');
    lines.push('');
    lines.push('Schema comparison requires Zod schema introspection at runtime.');
    lines.push('Run "pylon diff ${source} ${target}" for a detailed field-level diff.');
    lines.push('');
  } else {
    lines.push('## Changes');
    lines.push('');
    lines.push('No detailed changes detected. Define schemas in your pylon.config.ts');
    lines.push('to enable automatic changelog generation.');
    lines.push('');
  }

  // Check transform keys
  const transforms = config.transforms;
  if (transforms) {
    const relevantKeys = Object.keys(transforms).filter(
      (key) => key.includes(source) || key.includes(target),
    );
    if (relevantKeys.length > 0) {
      lines.push('## Related Transforms');
      lines.push('');
      for (const key of relevantKeys) {
        lines.push(`- \`${key}\``);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('_This changelog was auto generated. Review and update it with manual entries._');
  lines.push('');

  return lines.join('\n');
}
