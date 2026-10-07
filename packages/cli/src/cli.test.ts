import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = resolve('dist/index.js');

describe('CLI on Node', () => {
  it('creates runnable contracts, diagnoses them, exports specs, and benchmarks real fixtures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pylon-starter-'));
    try {
      symlinkSync(resolve('../../node_modules'), join(dir, 'node_modules'), 'dir');
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [cli, ...args], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 10_000,
        });
      const init = run('init');
      expect(init.status, init.stderr).toBe(0);
      const source = readFileSync(join(dir, 'pylon.config.ts'), 'utf8');
      expect(source).toContain('defineEndpoint');
      expect(source).not.toContain('TODO');
      const doctor = run('doctor', '--json');
      expect(doctor.status, doctor.stderr).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        valid: true,
        errors: [],
        warnings: [],
        versions: ['v1', 'v2'],
        endpoints: ['createUser'],
      });
      const typecheck = spawnSync(
        process.execPath,
        [
          resolve('../../node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--target',
          'ES2022',
          '--module',
          'ESNext',
          '--moduleResolution',
          'bundler',
          '--skipLibCheck',
          '--allowImportingTsExtensions',
          'pylon.config.ts',
          'pylon.example.ts',
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(typecheck.status, typecheck.stdout).toBe(0);
      const example = spawnSync('bun', ['pylon.example.ts'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(example.status, example.stderr).toBe(0);
      expect(example.stdout).toContain('v1');
      expect(example.stdout).toContain('createdAt');
      expect(run('generate', 'openapi', '--all-versions', '-o', 'specs').status).toBe(0);
      const historical = JSON.parse(readFileSync(join(dir, 'specs/v1.json'), 'utf8'));
      expect(historical.paths['/users'].post.responses['200']).toBeDefined();
      expect(historical.paths['/v1/users']).toBeUndefined();
      writeFileSync(join(dir, 'request.json'), JSON.stringify({ name: 'Ada' }));
      writeFileSync(
        join(dir, 'response.json'),
        JSON.stringify({ id: 1, fullName: 'Ada', createdAt: new Date().toISOString() }),
      );
      const bench = run(
        'bench',
        'v1',
        'v2',
        '--endpoint',
        'createUser',
        '--mode',
        'pipeline',
        '--input',
        'request.json',
        '--response',
        'response.json',
        '-n',
        '10',
        '--json',
      );
      expect(bench.status, bench.stderr).toBe(0);
      expect(JSON.parse(bench.stdout)).toMatchObject({
        source: 'v1',
        target: 'v2',
        mode: 'pipeline',
        iterations: 10,
      });
      const show = run('schema', 'show', 'v1', '--endpoint', 'createUser');
      expect(show.status, show.stderr).toBe(0);
      expect(JSON.parse(show.stdout).properties.name.type).toBe('string');
      const diff = run(
        'diff',
        'v1',
        'v2',
        '--endpoint',
        'createUser',
        '--direction',
        'response',
        '--json',
      );
      expect(diff.status, diff.stderr).toBe(0);
      expect(JSON.parse(diff.stdout)).toContainEqual(
        expect.objectContaining({ type: 'added', field: '/properties/createdAt' }),
      );
      expect(
        run('schema', 'validate', 'v1', '--endpoint', 'createUser', '--input', 'request.json')
          .status,
      ).toBe(0);
      expect(run('schema', 'show', 'v1-extra', '--endpoint', 'createUser').status).toBe(1);
      expect(run('bench', 'v1', 'v2', '--input', 'request.json', '-n', '10junk').status).toBe(1);
      expect(run('init').status).toBe(1);
      expect(readFileSync(join(dir, 'pylon.config.ts'), 'utf8')).toBe(source);
      expect(run('version', 'unpublish', 'v1').status).toBe(0);
      expect(run('doctor', '--json').status).toBe(0);
      expect(run('version', 'publish', 'v1').status).toBe(0);
      expect(run('version', 'retire', 'v1').status).toBe(0);
      expect(run('doctor', '--json').status).toBe(0);
      expect(run('version', 'publish', 'v1').status).toBe(1);
      expect(readFileSync(join(dir, 'pylon.config.ts'), 'utf8')).toContain('"retired": true');
      writeFileSync(
        join(dir, 'pylon.config.ts'),
        source.replace(
          'endpoints: { createUser }',
          'endpoints: { createUser }, observability: { metrics: true }',
        ),
      );
      const invalid = run('doctor', '--json');
      expect(invalid.status).toBe(1);
      expect(JSON.parse(invalid.stdout)).toMatchObject({ valid: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

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
      expect(spec.paths).toEqual({});
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
