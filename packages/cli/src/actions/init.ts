import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { PylonConfig } from '@ossl/pylon-core';
import { VersionNormalizer } from '@ossl/pylon-core';

const VERSION_PATTERNS = [
  /version\s*['"](\d+\.\d+\.\d+)['"]/g,
  /api['"]?\s*:\s*['"]v?(\d+)['"]/gi,
  /['"]v?(\d+)['"]\s*[:\]]/g,
  /accept-version/gi,
  /api-version/gi,
  /x-api-version/gi,
];

export async function initAction(
  options: { preset?: string; fromExisting?: string; example?: boolean } = {},
): Promise<void> {
  const configPath = join(process.cwd(), 'pylon.config.ts');
  const examplePath = join(process.cwd(), 'pylon.example.ts');
  if (existsSync(configPath)) throw new Error('pylon.config.ts already exists; no files changed.');
  if (options.example !== false && existsSync(examplePath))
    throw new Error('pylon.example.ts already exists; use --no-example to create config only.');
  let config = generatePresetConfig(options.preset ?? 'semantic');
  if (options.fromExisting) {
    const source = resolve(options.fromExisting);
    if (!statSync(source, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`Source directory not found: ${source}`);
    const versions = [...new Set(scanForVersions(source))].sort(
      new Intl.Collator('en', { numeric: true }).compare,
    );
    if (versions.length)
      config = { current: versions[versions.length - 1]!, versions, schemas: {}, transforms: {} };
    console.error(
      'Scanned release labels only. Generated /users endpoint is an example; define your real contracts explicitly.',
    );
  }
  const starter = renderStarter(config);
  writeFileSync(configPath, starter.config, { flag: 'wx' });
  try {
    if (options.example !== false) writeFileSync(examplePath, starter.example, { flag: 'wx' });
  } catch (error) {
    unlinkSync(configPath);
    throw error;
  }
  console.log(`Created ${configPath}`);
  console.log('Install: bun add @ossl/pylon-core @ossl/pylon-hono hono zod');
  console.log('Check: pylon doctor');
  if (options.example !== false) console.log('Run: bun pylon.example.ts');
}

export function generateDefaultConfig(): PylonConfig {
  return generatePresetConfig('semantic');
}

export function generatePresetConfig(preset: string): PylonConfig {
  let versions: string[];
  if (preset === 'semantic') versions = ['v1', 'v2'];
  else if (preset === 'numeric') versions = ['1', '2'];
  else if (preset === 'stripe')
    versions = [
      new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10),
    ];
  else throw new Error(`Unknown preset: "${preset}". Choose semantic, numeric, or stripe.`);
  return { current: versions[1]!, versions, schemas: {}, transforms: {} };
}

/** Executable migration example, with independent request and response schemas. */
export function renderStarter(config: PylonConfig): { config: string; example: string } {
  const versions = new VersionNormalizer(config.versions, config.current)
    .listVersions()
    .map((v) => v.name);
  const contracts = versions
    .map((version, index) => {
      const legacy = index === 0 && versions.length > 1;
      const field = legacy ? 'name' : 'fullName';
      return `    ${JSON.stringify(version)}: {
      request: z.object({ ${field}: z.string().min(1) }),
      response: z.object({ id: z.number(), ${field}: z.string()${legacy ? '' : ', createdAt: z.string().datetime()'} }),
    },`;
    })
    .join('\n');
  const transforms = versions
    .slice(0, -1)
    .map(
      (version, index) => `    ${JSON.stringify(`${version}->${versions[index + 1]}`)}: {
      request: ${index === 0 ? '(input) => ({ fullName: input.name })' : "'identity'"},
      response: ${index === 0 ? '(output) => ({ id: output.id, name: output.fullName })' : "'identity'"},
    },`,
    )
    .join('\n');
  return {
    config: `import { defineConfig, defineEndpoint } from '@ossl/pylon-core';
import { z } from 'zod';

export const createUser = defineEndpoint({
  method: 'POST',
  path: '/users',
  contracts: {
${contracts}
  },
  transforms: {
${transforms}
  },
});

export default defineConfig({
  current: ${JSON.stringify(config.current)},
  versions: ${JSON.stringify(versions)},
  endpoints: { createUser },
});
`,
    example: `import { Pylon, type EndpointInput } from '@ossl/pylon-core';
import { pylonHono } from '@ossl/pylon-hono';
import { Hono } from 'hono';
import config, { createUser } from './pylon.config.ts';

type UserInput = EndpointInput<typeof createUser, typeof config.current>;
const app = new Hono();
const pylon = new Pylon(config);
app.use('*', pylonHono(pylon));
app.post('/users', async (c) => {
  const input = await c.req.json<UserInput>();
  return c.json({ id: 1, fullName: input.fullName, createdAt: new Date().toISOString() });
});

const versions = pylon.normalizer.listVersions();
for (const [index, definition] of versions.entries()) {
  const version = definition.name;
  if (pylon.isUnpublished(version)) continue;
  const response = await app.request('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-version': version },
    body: JSON.stringify(index === 0 && versions.length > 1 ? { name: 'Ada' } : { fullName: 'Ada' }),
  });
  if (!response.ok) throw new Error(await response.text());
  console.log(version, await response.json());
}

export { app };
`,
  };
}

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
