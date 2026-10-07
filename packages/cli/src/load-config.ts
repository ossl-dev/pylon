import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PylonConfig, VersionDefinition, VersionsConfig } from '@ossl/pylon-core';
import { defineConfig, validateConfig } from '@ossl/pylon-core';
import { createJiti } from 'jiti';
import { updateConfigSource } from './config-source.js';

const CONFIG_FILES = [
  'pylon.config.ts',
  'pylon.config.js',
  'pylon.config.mjs',
  'pylon.config.json',
];

const SCHEMA_PLACEHOLDER = `
  // TODO: Define your schemas using zod
  // Example:
  //   v1: z.object({ name: z.string() }),
  //   v2: z.object({ name: z.string(), email: z.string() }),
`;

const TRANSFORM_PLACEHOLDER = `
  // TODO: Define your transforms between versions
  // Example:
  //   "v1->v2": {
  //     request: (input) => ({ ...input, email: input.email ?? '' }),
  //     response: (output) => {
  //       const { email, ...rest } = output;
  //       return rest;
  //     },
  //   },
`;

/**
 * Result from loading a configuration.
 */
export interface LoadedConfig {
  /** The parsed config object */
  config: PylonConfig;
  /** Absolute path to the config file */
  configPath: string;
}

/**
 * Load pylon.config.ts from the working directory.
 *
 * Uses dynamic import to load the config file. Falls back to JSON.parse
 * for .json files. Validates the config against the core schema.
 *
 * @throws if no config file is found or the config is invalid
 */
export async function loadPylonConfig(startPath?: string): Promise<LoadedConfig> {
  const configPath = await findConfig(startPath);
  if (!configPath) {
    throw new Error(
      'No pylon.config.ts found in working directory.\n' + 'Run "pylon init" to create one.',
    );
  }

  const config = defineConfig(await importConfig(configPath));
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid pylon configuration:\n${validation.errors.join('\n')}`);
  }

  return { config, configPath };
}

/**
 * Find and return the path to the pylon config file in or above the given
 * directory. Searches for pylon.config.ts, .js, .mjs, and .json files.
 *
 * @param startPath - Directory to start searching from (defaults to cwd)
 * @returns The absolute path to the config file, or null if not found
 */
export async function findConfig(startPath?: string): Promise<string | null> {
  let dir = startPath ? resolve(startPath) : process.cwd();
  while (true) {
    for (const file of CONFIG_FILES) {
      const fullPath = join(dir, file);
      if (existsSync(fullPath)) return fullPath;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Dynamically import a config file by its path.
 * Supports .ts, .js, .mjs, and .json extensions.
 */
async function importConfig(filePath: string): Promise<PylonConfig> {
  const ext = filePath.split('.').pop()?.toLowerCase();

  if (ext === 'json') {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as PylonConfig;
  }

  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
  const mod = await jiti.import<{ default?: PylonConfig } & PylonConfig>(filePath);
  return mod.default ?? mod;
}

/**
 * Format a single version definition to its config string representation.
 */
function formatVersionDef(v: VersionDefinition, indent: string): string {
  const parts = [`name: ${JSON.stringify(v.name)}`, `order: ${v.order}`];
  if (v.deprecated) {
    parts.push('deprecated: true');
  }
  if (v.unpublished) parts.push('unpublished: true');
  if (v.retired) parts.push('retired: true');
  if (v.sunsetDate) parts.push(`sunsetDate: ${JSON.stringify(v.sunsetDate)}`);
  if (v.aliases) parts.push(`aliases: ${JSON.stringify(v.aliases)}`);
  if (v.migrationGuide) parts.push(`migrationGuide: ${JSON.stringify(v.migrationGuide)}`);
  return `${indent}{ ${parts.join(', ')} }`;
}

/**
 * Generate the TypeScript source content for a Pylon config file.
 *
 * Produces a valid pylon.config.ts that wraps the config in `defineConfig`.
 * Schemas and transforms are output as placeholder comments when they
 * contain actual Zod schema instances or functions that cannot be serialized.
 *
 * @param config - The config to serialize
 * @param keepSchemas - If true, try to serialize schemas (use with caution)
 * @param keepTransforms - If true, try to serialize transforms (use with caution)
 */
export function generateConfigContent(
  config: PylonConfig,
  keepSchemas = false,
  keepTransforms = false,
): string {
  const lines: string[] = [];
  const hasZodSchemas = config.schemas && Object.keys(config.schemas).length > 0;

  // Collect imports
  if (hasZodSchemas) {
    lines.push('import { z } from "zod";');
  }
  lines.push('import { defineConfig } from "@ossl/pylon-core";');
  lines.push('');

  // Opening
  lines.push('export default defineConfig({');

  // current
  lines.push(`  current: ${JSON.stringify(config.current)},`);

  // defaultVersion
  if (config.defaultVersion) {
    lines.push(`  defaultVersion: ${JSON.stringify(config.defaultVersion)},`);
  }

  // versions
  if (config.versions) {
    lines.push(...serializeVersions(config.versions));
  }

  // schemas
  if (hasZodSchemas && keepSchemas && !keepTransforms) {
    // Mixed — skip both
    lines.push('  schemas: {},');
    lines.push('  // NOTE: schemas omitted — please re-add from your backup');
  } else if (hasZodSchemas && keepSchemas) {
    lines.push('  schemas: {},');
    lines.push(SCHEMA_PLACEHOLDER);
  } else {
    lines.push('  schemas: {},');
    if (hasZodSchemas) {
      lines.push('  // NOTE: schemas were stripped during serialization. Re-add manually.');
    }
  }

  // transforms
  const hasTransforms = config.transforms && Object.keys(config.transforms).length > 0;
  if (hasTransforms && keepTransforms) {
    lines.push('  transforms: {},');
    lines.push(TRANSFORM_PLACEHOLDER);
  } else {
    lines.push('  transforms: {},');
    if (hasTransforms) {
      lines.push('  // NOTE: transforms were stripped during serialization. Re-add manually.');
    }
  }

  // versioning
  if (config.versioning) {
    lines.push(
      `  versioning: ${JSON.stringify(config.versioning, null, 4).replace(/\n/g, '\n  ')},`,
    );
  }

  // endpoints
  if (config.endpoints) {
    lines.push(`  endpoints: ${JSON.stringify(config.endpoints, null, 4).replace(/\n/g, '\n  ')},`);
  }

  // observability
  if (config.observability) {
    lines.push(
      `  observability: ${JSON.stringify(config.observability, null, 4).replace(/\n/g, '\n  ')},`,
    );
  }

  // debug
  if (config.debug) {
    lines.push(`  debug: ${JSON.stringify(config.debug)},`);
  }

  // Closing
  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

/**
 * Serialize the VersionsConfig field.
 */
export function serializeVersions(versions: VersionsConfig): string[] {
  const lines: string[] = [];

  if (Array.isArray(versions)) {
    if (versions.length === 0) {
      lines.push('  versions: [],');
      return lines;
    }
    lines.push('  versions: [');
    for (let i = 0; i < versions.length; i++) {
      const comma = i < versions.length - 1 ? ',' : '';
      const version = versions[i]!;
      lines.push(
        `${typeof version === 'string' ? `    ${JSON.stringify(version)}` : formatVersionDef(version, '    ')}${comma}`,
      );
    }
    lines.push('  ],');
    return lines;
  }

  if ('preset' in versions && versions.preset === 'stripe') {
    const fields = ['preset: "stripe"'];
    if (versions.start) fields.push(`start: ${JSON.stringify(versions.start)}`);
    if (versions.end) fields.push(`end: ${JSON.stringify(versions.end)}`);
    lines.push(`  versions: { ${fields.join(', ')} },`);
    return lines;
  }

  if ('format' in versions) {
    const v = versions;
    if (v.format === 'custom') {
      lines.push('  // Custom version format — re-add your parse/format functions');
      lines.push(`  versions: ${JSON.stringify({ format: 'custom' })},`);
      return lines;
    }
    const fields = [`format: ${JSON.stringify(v.format)}`];
    if (v.prefix) fields.push(`prefix: ${JSON.stringify(v.prefix)}`);
    if (v.dateFormat) fields.push(`dateFormat: ${JSON.stringify(v.dateFormat)}`);
    if (v.calverFormat) fields.push(`calverFormat: ${JSON.stringify(v.calverFormat)}`);
    if (v.start) fields.push(`start: ${JSON.stringify(v.start)}`);
    if (v.end) fields.push(`end: ${JSON.stringify(v.end)}`);
    if (v.aliases) fields.push(`aliases: ${JSON.stringify(v.aliases)}`);
    lines.push(`  versions: { ${fields.join(', ')} },`);
    return lines;
  }

  lines.push('  versions: {},');
  return lines;
}

/**
 * Write a Pylon config to the given path.
 *
 * Existing files retain their runtime expressions; only current and versions change.
 * New files use the initial config scaffold.
 *
 * @param path - Absolute path to write the config file to
 * @param config - The config to write
 */
export async function writeConfig(path: string, config: PylonConfig): Promise<void> {
  if (existsSync(path)) {
    const validation = validateConfig(config);
    if (!validation.valid)
      throw new Error(`Cannot save invalid configuration:\n${validation.errors.join('\n')}`);
    const source = readFileSync(path, 'utf-8');
    if (path.endsWith('.json')) {
      const original = JSON.parse(source);
      writeFileSync(
        path,
        `${JSON.stringify({ ...original, current: config.current, versions: config.versions }, null, 2)}\n`,
        'utf-8',
      );
    } else {
      const updated = updateConfigSource(source, config);
      writeFileSync(path, updated, 'utf-8');
    }
    return;
  }
  writeFileSync(path, generateConfigContent(config), { encoding: 'utf-8', flag: 'wx' });
}
