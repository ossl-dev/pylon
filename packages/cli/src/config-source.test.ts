import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateConfigSource } from './config-source.js';
import { loadPylonConfig, writeConfig } from './load-config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'pylon-config-'));
  dirs.push(dir);
  return dir;
}
const updated = {
  current: 'v3',
  versions: [
    { name: 'v2', order: 1 },
    { name: 'v3', order: 2 },
  ],
  schemas: {},
  transforms: {},
};

describe('safe config updates', () => {
  it('preserves schemas, transforms, imports, regexes, and comments byte for byte', () => {
    const runtime = `schemas: { v2: z.object({ name: z.string() }) },
  transforms: { 'v2->v3': { request: input => ({ ...input, flag: true }) } },
  versioning: { sources: [{ type: 'path', pattern: /\\/(v\\d+)\\// }] },
  // keep this comment`;
    const source = `import { z } from 'zod';\nexport default defineConfig({ current: 'v2', versions: [],\n  ${runtime}\n});\n`;
    const result = updateConfigSource(source, updated);
    expect(result).toContain(runtime);
    expect(result).toContain("import { z } from 'zod';");
    expect(result).toContain('current: "v3"');
  });

  it('handles a default-exported variable with shorthand version fields', () => {
    const source = `const current = 'v2'; const config = { current, schemas: {}, transforms: {} } satisfies PylonConfig; export default config;`;
    const result = updateConfigSource(source, updated);
    expect(result).toContain('current: "v3"');
    expect(result).toContain('versions: [');
    expect(result).toContain('satisfies PylonConfig');
  });

  it('refuses dynamic configs without overwriting the file', async () => {
    const path = join(temp(), 'pylon.config.ts');
    const source = 'export default { ...getConfig(), current: "v2" };';
    writeFileSync(path, source);
    await expect(writeConfig(path, updated)).rejects.toThrow('Cannot safely edit');
    expect(readFileSync(path, 'utf8')).toBe(source);
  });

  it('retains all JSON fields when updating metadata', async () => {
    const path = join(temp(), 'pylon.config.json');
    writeFileSync(path, JSON.stringify({ ...updated, debug: { enabled: true } }));
    await writeConfig(path, { ...updated, current: 'v2' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('debug.enabled', true);
  });

  it('loads TypeScript configs and their TypeScript imports from child directories', async () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'schema.ts'),
      'export const schema = { parse: (value: unknown) => value };',
    );
    const path = join(dir, 'pylon.config.ts');
    writeFileSync(
      path,
      `import { schema } from './schema.ts'; const current: string = 'v2'; export default { current, schemas: { v2: schema }, transforms: {} };`,
    );
    mkdirSync(join(dir, 'src'));
    const loaded = await loadPylonConfig(join(dir, 'src'));
    expect(loaded.configPath).toBe(path);
    expect(loaded.config.schemas.v2?.parse({ name: 'Ada' })).toEqual({ name: 'Ada' });
    await writeConfig(path, updated);
    expect((await loadPylonConfig(dir)).config.current).toBe('v3');
    expect(readFileSync(path, 'utf8')).toContain("import { schema } from './schema.ts'");
  });
});
