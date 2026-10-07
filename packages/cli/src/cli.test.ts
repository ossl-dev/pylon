import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = resolve('dist/index.js');

describe('CLI on Node', () => {
  it('generates OpenAPI and changes versions without stripping runtime config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pylon-cli-node-'));
    try {
      symlinkSync(resolve('../../node_modules'), join(dir, 'node_modules'), 'dir');
      const runtime = `schemas: { v1: z.object({ name: z.string() }), v2: z.object({ fullName: z.string() }) },
transforms: { 'v1->v2': { request: (input: { name: string }) => ({ fullName: input.name }), response: (output: { fullName: string }) => ({ name: output.fullName }) } },`;
      writeFileSync(
        join(dir, 'pylon.config.ts'),
        `import { z } from 'zod';\nimport { defineConfig } from '@ossl/pylon-core';\nexport default defineConfig({ current: 'v2', versions: { format: 'semantic' }, ${runtime} });`,
      );
      const generate = spawnSync(
        process.execPath,
        [cli, 'generate', 'openapi', '--output', 'generated/openapi.json'],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(generate.stderr).toBe('');
      expect(generate.status).toBe(0);
      const spec = JSON.parse(readFileSync(join(dir, 'generated/openapi.json'), 'utf8'));
      expect(spec.components.schemas.v1_request.properties.name.type).toBe('string');
      expect(spec.paths['/v1/users'].post).toBeDefined();
      const deprecate = spawnSync(process.execPath, [cli, 'version', 'deprecate', 'v1'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(deprecate.stderr).toBe('');
      expect(deprecate.status).toBe(0);
      const source = readFileSync(join(dir, 'pylon.config.ts'), 'utf8');
      expect(source).toContain(runtime);
      expect(source).toContain('"deprecated": true');
      const list = spawnSync(process.execPath, [cli, 'version', 'list'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(list.status).toBe(0);
      expect(list.stdout).toContain('v1 (deprecated)');
      expect(list.stdout).toContain('v2 (current)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
