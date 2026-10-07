import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { PylonConfig, VersionDefinition } from '@ossl/pylon-core';
import { writeConfig } from '../load-config.js';

/**
 * Regex patterns used to detect versioning-related code in source files.
 */
const VERSION_PATTERNS = [
  /version\s*['"](\d+\.\d+\.\d+)['"]/g,
  /api['"]?\s*:\s*['"]v?(\d+)['"]/gi,
  /['"]v?(\d+)['"]\s*[:\]]/g,
  /accept-version/gi,
  /api-version/gi,
  /x-api-version/gi,
];

/**
 * Create pylon.config.ts interactively or from presets.
 *
 * If --from-existing is provided, the source path is scanned for versioning
 * patterns in source files. If --preset is provided, a preset configuration
 * is generated. Otherwise the user is prompted for configuration choices.
 */
export async function initAction(options: {
  preset?: string;
  fromExisting?: string;
}): Promise<void> {
  const cwd = process.cwd();
  const configPath = join(cwd, 'pylon.config.ts');

  if (existsSync(configPath)) {
    console.error('pylon.config.ts already exists in the current directory.');
    console.error('Delete it first, or use a different directory.');
    process.exit(1);
  }

  let config: PylonConfig | null = null;

  if (options.fromExisting) {
    config = await fromExistingAction(options.fromExisting);
  } else if (options.preset) {
    config = generatePresetConfig(options.preset);
  } else {
    config = await interactiveInit();
  }

  if (!config) {
    console.error('Failed to generate configuration.');
    process.exit(1);
  }

  await writeConfig(configPath, config);
  console.log(`Created ${configPath}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Review the generated config in pylon.config.ts');
  console.log('  2. Define your schemas using zod');
  console.log('  3. Add transform functions between versions');
  console.log('  4. Run "pylon schema validate <version>" to validate schemas');
}

/**
 * Analyze an existing codebase for versioning patterns and generate a config.
 */
async function fromExistingAction(path: string): Promise<PylonConfig> {
  const resolvedPath = resolve(path);
  console.error(`Scanning ${resolvedPath} for versioning patterns...`);

  const detectedVersions = scanForVersions(resolvedPath);
  const uniqueVersions = [...new Set(detectedVersions)];

  if (uniqueVersions.length === 0) {
    console.error('No versioning patterns detected. Generating default config.');
    return generateDefaultConfig();
  }

  uniqueVersions.sort();

  const versions: VersionDefinition[] = uniqueVersions.map((v, i) => ({
    name: v,
    order: i + 1,
  }));

  const current = versions[versions.length - 1]!.name;

  console.error(`Detected versions: ${uniqueVersions.join(', ')}`);

  return {
    current,
    versions,
    schemas: {},
    transforms: {},
  };
}

/**
 * Scan a directory recursively for versioning patterns in source files.
 */
export function scanForVersions(dir: string): string[] {
  const versions: string[] = [];
  const skipDirs = new Set(['node_modules', 'dist', '.git', '.next', 'build']);

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
          if (!skipDirs.has(entry) && !entry.startsWith('.')) {
            walk(fullPath);
          }
        } else if (stats.isFile()) {
          const ext = extname(fullPath);
          if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
            try {
              const content = readFileSync(fullPath, 'utf-8');
              for (const pattern of VERSION_PATTERNS) {
                pattern.lastIndex = 0;
                for (const match of content.matchAll(pattern)) {
                  if (match[1]) {
                    versions.push(match[1]);
                  }
                }
              }
            } catch {
              // Skip files that can't be read
            }
          }
        }
      } catch {
        // Skip entries that can't be accessed
      }
    }
  }

  walk(dir);
  return versions;
}

/**
 * Generate a configuration based on a preset name.
 */
export function generatePresetConfig(preset: string): PylonConfig {
  switch (preset) {
    case 'semantic': {
      return {
        current: 'v3',
        versions: { format: 'semantic', prefix: 'v' },
        schemas: {},
        transforms: {},
      };
    }

    case 'numeric': {
      return {
        current: '3',
        versions: { format: 'numeric' },
        schemas: {},
        transforms: {},
      };
    }

    case 'stripe': {
      return {
        current: new Date().toISOString().split('T')[0]!,
        versions: { preset: 'stripe' },
        schemas: {},
        transforms: {},
      };
    }

    default: {
      console.error(`Unknown preset "${preset}". Using default.`);
      return generateDefaultConfig();
    }
  }
}

/**
 * Generate a default Pylon config.
 */
export function generateDefaultConfig(): PylonConfig {
  return {
    current: 'v1',
    versions: { format: 'semantic', prefix: 'v' },
    schemas: {},
    transforms: {},
  };
}

/**
 * Interactive initialization — prompts user for config choices.
 *
 * Uses simple readline prompts since we want zero extra dependencies.
 */
async function interactiveInit(): Promise<PylonConfig> {
  const readline = (await import('node:readline')).default;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (query: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(query, (answer) => {
        resolve(answer.trim());
      });
    });
  };

  console.error('');
  console.error('Pylon Configuration Wizard');
  console.error('==========================');
  console.error('');

  const current = await ask('Current API version (e.g. v2, 3, 2024-01-15) [v1]: ');
  const currentVersion = current || 'v1';

  const formatTypes = ['semantic', 'numeric', 'date-monthly', 'date-daily'];
  const formatStr = await ask(`Version format (${formatTypes.join(', ')}) [semantic]: `);
  const format = (formatStr || 'semantic') as
    | 'semantic'
    | 'numeric'
    | 'date-monthly'
    | 'date-daily';

  const prefixStr = await ask('Version prefix (e.g. "v") [v]: ');
  const prefix = format === 'semantic' ? prefixStr || 'v' : undefined;

  // Parse number of schemas (currently unused, reserved for future)
  await ask('Number of schemas (endpoints) to define [0]: ');

  rl.close();

  const config: PylonConfig = {
    current: currentVersion,
    versions: {
      format,
      ...(prefix ? { prefix } : {}),
    },
    schemas: {},
    transforms: {},
  };

  console.error(`\nGenerating config with current=${currentVersion}, format=${format}...\n`);

  return config;
}
