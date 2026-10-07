import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { PylonConfig, VersionDefinition } from '@ossl/pylon-core';
import { writeConfig } from '../load-config.js';

/**
 * Options for the scaffold command.
 */
export interface ScaffoldOptions {
  /** Output directory for generated files */
  output?: string;
}

// Regex patterns for detecting version-specific logic
const VERSION_IN_CODE = /['"](v?\d+)['"]/g;
const VERSION_COMPARISON = /(?:>=?|<=?|===?)\s*['"]v?(\d+)['"]/g;
const ROUTE_WITH_VERSION = /\/(?:api\/)?v?(\d+)\//g;

/**
 * Analyze source files for version-specific logic and generate initial
 * schema files per detected version, transform stubs, and a pylon.config.ts.
 */
export async function scaffoldAction(path: string, options: ScaffoldOptions): Promise<void> {
  const resolvedPath = resolve(path);

  if (!statSync(resolvedPath, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Path "${resolvedPath}" is not a valid directory.`);
    process.exit(1);
  }

  console.error(`Analyzing ${resolvedPath} for version patterns...`);

  const versions = detectVersions(resolvedPath);
  const uniqueVersionStrs = [...new Set(versions)].sort((a, b) => {
    const aNum = parseInt(a.replace(/v/i, ''), 10);
    const bNum = parseInt(b.replace(/v/i, ''), 10);
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
    return a.localeCompare(b);
  });

  if (uniqueVersionStrs.length === 0) {
    console.error('No version patterns detected. Generating single-version scaffold.');
    uniqueVersionStrs.push('v1');
  }

  const outputDir = options.output ? resolve(options.output) : resolve('pylon');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Generate schema files per version
  const schemasDir = join(outputDir, 'schemas');
  if (!existsSync(schemasDir)) {
    mkdirSync(schemasDir, { recursive: true });
  }

  for (const version of uniqueVersionStrs) {
    generateSchemaFile(version, schemasDir);
  }

  // Generate transform stubs
  const transformsDir = join(outputDir, 'transforms');
  if (!existsSync(transformsDir)) {
    mkdirSync(transformsDir, { recursive: true });
  }

  for (let i = 0; i < uniqueVersionStrs.length - 1; i++) {
    const source = uniqueVersionStrs[i]!;
    const target = uniqueVersionStrs[i + 1]!;
    generateTransformFile(source, target, transformsDir);
  }

  // Generate pylon.config.ts
  const versionDefs: VersionDefinition[] = uniqueVersionStrs.map((v, i) => ({
    name: v,
    order: i + 1,
  }));

  const config: PylonConfig = {
    current: versionDefs[versionDefs.length - 1]!.name,
    versions: versionDefs,
    schemas: {},
    transforms: {},
  };

  const configPath = join(outputDir, 'pylon.config.ts');
  await writeConfig(configPath, config);

  console.error('');
  console.error(`Scaffold generated in ${outputDir}/`);
  console.error('');
  console.error('  Generated files:');
  for (const v of uniqueVersionStrs) {
    console.error(`    - schemas/${sanitizeFilename(v)}.ts`);
  }
  for (let i = 0; i < uniqueVersionStrs.length - 1; i++) {
    console.error(
      `    - transforms/${sanitizeFilename(uniqueVersionStrs[i]!)}-to-${sanitizeFilename(uniqueVersionStrs[i + 1]!)}.ts`,
    );
  }
  console.error(`    - pylon.config.ts`);
  console.error('');
  console.error('Next steps:');
  console.error('  1. Define your schemas in the generated schema files');
  console.error('  2. Implement transform functions in the transform files');
  console.error('  3. Import and wire them up in pylon.config.ts');
  console.error('  4. Run "pylon schema validate" to check your schemas');
}

/**
 * Scan the codebase recursively for version strings and patterns.
 */
export function detectVersions(dir: string): string[] {
  const versions: string[] = [];
  const skipDirs = new Set(['node_modules', 'dist', '.git', '.next', 'build', 'coverage']);

  function walk(currentPath: string): void {
    let entries: string[];
    try {
      entries = readdirSync(currentPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentPath, entry);

      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          if (!skipDirs.has(entry)) {
            walk(fullPath);
          }
        } else if (stats.isFile()) {
          const ext = extname(fullPath);
          if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
            const content = readFileSync(fullPath, 'utf-8');

            // Look for version strings in code
            const versionRegex = new RegExp(VERSION_IN_CODE.source, 'g');
            for (const match of content.matchAll(versionRegex)) {
              if (match[1] && !versions.includes(match[1])) {
                versions.push(match[1]);
              }
            }

            // Look for version comparisons
            const comparisonRegex = new RegExp(VERSION_COMPARISON.source, 'g');
            for (const match of content.matchAll(comparisonRegex)) {
              if (match[1] && !versions.includes(match[1])) {
                versions.push(match[1]);
              }
            }

            // Look for versioned routes
            const routeRegex = new RegExp(ROUTE_WITH_VERSION.source, 'g');
            for (const match of content.matchAll(routeRegex)) {
              if (match[1] && !versions.includes(match[1])) {
                versions.push(match[1]);
              }
            }
          }
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  walk(dir);
  return versions;
}

/**
 * Generate a TypeScript schema file for a given version.
 */
function generateSchemaFile(version: string, outputDir: string): void {
  const filename = `${sanitizeFilename(version)}.ts`;
  const filePath = join(outputDir, filename);

  const content = `// Schema for version ${version}
// TODO: Define your request/response schemas using zod

import { z } from 'zod';

export const requestSchema = z.object({
  // TODO: Define request schema fields for version ${version}
  // Example:
  // id: z.string(),
  // name: z.string(),
});

export const responseSchema = z.object({
  // TODO: Define response schema fields for version ${version}
  // Example:
  // id: z.string(),
  // name: z.string(),
  // createdAt: z.string(),
});

export type Request = z.infer<typeof requestSchema>;
export type Response = z.infer<typeof responseSchema>;
`;

  writeFileSync(filePath, content, 'utf-8');
}

/**
 * Generate a TypeScript transform file between two versions.
 */
function generateTransformFile(source: string, target: string, outputDir: string): void {
  const filename = `${sanitizeFilename(source)}-to-${sanitizeFilename(target)}.ts`;
  const filePath = join(outputDir, filename);

  const content = `// Transform: ${source} -> ${target}
// TODO: Implement request and response transforms

import type { TransformPair } from '@ossl/pylon-core';

const transform: TransformPair = {
  /**
   * Transform a request from ${source} format to ${target} format.
   * This is called when a ${source} client sends a request — the data
   * is upgraded to ${target} before the handler processes it.
   */
  request: (input: any) => {
    // TODO: Implement ${source} -> ${target} request transform
    // Example:
    //   const { oldField, ...rest } = input;
    //   return { ...rest, newField: oldField };
    return input;
  },

  /**
   * Transform a response from ${target} format back to ${source} format.
   * This is called before sending the response back to a ${source} client —
   * the ${target} response is downgraded to ${source}.
   */
  response: (output: any) => {
    // TODO: Implement ${target} -> ${source} response transform
    // Example:
    //   const { newField, ...rest } = output;
    //   return { ...rest, oldField: newField };
    return output;
  },
};

export default transform;
`;

  writeFileSync(filePath, content, 'utf-8');
}

/**
 * Sanitize a version string for use as a filename.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
