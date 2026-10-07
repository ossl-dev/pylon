import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PylonConfig, VersionDefinition, VersionsConfig } from '@ossl/pylon-core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuditResult } from './actions/audit.js';
import { generateSuggestions, scanCodebase } from './actions/audit.js';
import { createTestPayload } from './actions/bench.js';
import type { ChangelogSection, SchemaChange, SchemaField, SchemaShape } from './actions/diff.js';
import {
  compareShapes,
  detectRenames,
  extractSchemaShape,
  nameSimilarity,
} from './actions/diff.js';
import { buildChangelog, buildOpenAPISpec, extractVersions } from './actions/generate.js';
import { generateDefaultConfig, generatePresetConfig, scanForVersions } from './actions/init.js';
import { detectVersions, sanitizeFilename } from './actions/scaffold.js';
import { ensureVersionsArray, sortVersions } from './actions/version.js';
import { findConfig, generateConfigContent, serializeVersions } from './load-config.js';

// NOTE: src/index.ts (the Commander entry point) is not directly testable —
// it calls program.parse(process.argv) at module load and wires every action
// to process.exit() on failure. The tests below cover the pure helpers and
// directory-scanning utilities that the actions are built from.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/**
 * Create a fresh temp directory for filesystem-based tests. The directory is
 * removed automatically after each test.
 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pylon-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Write a file (creating parent directories as needed) inside a temp dir. */
function writeFile(rootDir: string, relativePath: string, content: string): void {
  const fullPath = join(rootDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal PylonConfig for tests that don't care about the schema contents. */
function baseConfig(overrides: Partial<PylonConfig> = {}): PylonConfig {
  return {
    current: 'v2',
    schemas: {},
    transforms: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// load-config.ts
// ---------------------------------------------------------------------------

describe('serializeVersions', () => {
  it('serializes an empty array', () => {
    expect(serializeVersions([])).toEqual(['  versions: [],']);
  });

  it('serializes a version list with metadata', () => {
    const config = baseConfig({
      versions: [
        { name: 'v1', order: 1 },
        { name: 'v2', order: 2, deprecated: true, sunsetDate: '2026-12-31' },
      ],
    });
    expect(serializeVersions(config.versions!)).toEqual([
      '  versions: [',
      '    { name: "v1", order: 1 },',
      '    { name: "v2", order: 2, deprecated: true, sunsetDate: "2026-12-31" }',
      '  ],',
    ]);
  });

  it('serializes the stripe preset', () => {
    expect(serializeVersions({ preset: 'stripe' })).toEqual(['  versions: { preset: "stripe" },']);
  });

  it('serializes a format-based config with prefix and aliases', () => {
    expect(
      serializeVersions({
        format: 'semantic',
        prefix: 'v',
        aliases: { latest: 'v3' },
      }),
    ).toEqual(['  versions: { format: "semantic", prefix: "v", aliases: {"latest":"v3"} },']);
  });

  it('strips functions from custom format configs', () => {
    expect(serializeVersions({ format: 'custom' } as VersionsConfig)).toEqual([
      '  // Custom version format — re-add your parse/format functions',
      '  versions: {"format":"custom"},',
    ]);
  });

  it('falls back to an empty object for unknown shapes', () => {
    expect(serializeVersions({} as never)).toEqual(['  versions: {},']);
  });
});

describe('findConfig', () => {
  it('returns null when no config file exists', async () => {
    const dir = makeTempDir();
    await expect(findConfig(dir)).resolves.toBeNull();
  });

  it('finds pylon.config.ts', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'pylon.config.ts', 'export default {};');
    await expect(findConfig(dir)).resolves.toBe(join(dir, 'pylon.config.ts'));
  });

  it('prefers .ts over .json when both exist', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'pylon.config.ts', 'export default {};');
    writeFile(dir, 'pylon.config.json', '{}');
    await expect(findConfig(dir)).resolves.toBe(join(dir, 'pylon.config.ts'));
  });

  it('falls back to pylon.config.json', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'pylon.config.json', '{}');
    await expect(findConfig(dir)).resolves.toBe(join(dir, 'pylon.config.json'));
  });
});

describe('generateConfigContent', () => {
  it('wraps a minimal config in defineConfig', () => {
    const content = generateConfigContent(baseConfig({ current: 'v1' }));
    expect(content).toContain('import { defineConfig } from "@ossl/pylon-core";');
    expect(content).toContain('export default defineConfig({');
    expect(content).toContain('  current: "v1",');
    expect(content).toContain('  schemas: {},');
    expect(content).toContain('  transforms: {},');
    expect(content).toContain('});');
  });

  it('does not import zod when no schemas are defined', () => {
    const content = generateConfigContent(baseConfig());
    expect(content).not.toContain('import { z } from "zod";');
  });

  it('serializes the versions list', () => {
    const config = baseConfig({
      versions: [
        { name: 'v1', order: 1 },
        { name: 'v2', order: 2 },
      ],
    });
    const content = generateConfigContent(config);
    expect(content).toContain('  versions: [');
    expect(content).toContain('    { name: "v1", order: 1 },');
    expect(content).toContain('    { name: "v2", order: 2 }');
    expect(content).toContain('  ],');
  });

  it('serializes format-based versions, defaultVersion, and debug', () => {
    const config = baseConfig({
      current: 'v2',
      defaultVersion: 'v1',
      versions: { format: 'semantic', prefix: 'v' },
      debug: { enabled: true },
    });
    const content = generateConfigContent(config);
    expect(content).toContain('  defaultVersion: "v1",');
    expect(content).toContain('  versions: { format: "semantic", prefix: "v" },');
    expect(content).toContain('  debug: {"enabled":true},');
  });

  it('strips zod schemas with a note by default', () => {
    const config = baseConfig({
      schemas: { v1: z.object({ name: z.string() }) },
    });
    const content = generateConfigContent(config);
    expect(content).toContain('import { z } from "zod";');
    expect(content).toContain('  schemas: {},');
    expect(content).toContain(
      '  // NOTE: schemas were stripped during serialization. Re-add manually.',
    );
  });

  it('emits a placeholder when keepSchemas is set', () => {
    const config = baseConfig({
      schemas: { v1: z.object({ name: z.string() }) },
    });
    const content = generateConfigContent(config, true, true);
    expect(content).toContain('// TODO: Define your schemas using zod');
  });

  it('emits a placeholder when keepTransforms is set', () => {
    const config = baseConfig({
      transforms: { 'v1->v2': { request: (input: unknown) => input } },
    });
    const content = generateConfigContent(config, true, true);
    expect(content).toContain('// TODO: Define your transforms between versions');
  });

  it('notes that schemas were omitted when only schemas are kept', () => {
    const config = baseConfig({
      schemas: { v1: z.object({ name: z.string() }) },
    });
    const content = generateConfigContent(config, true, false);
    expect(content).toContain('  // NOTE: schemas omitted — please re-add from your backup');
  });

  it('serializes versioning, endpoints, and observability sections', () => {
    const config = baseConfig({
      versioning: {
        sources: [{ type: 'header', name: 'api-version' }],
        onMissing: 'reject',
      },
      endpoints: {
        'users.create': { schemas: { v1: z.object({ name: z.string() }) } },
      },
      observability: { onTransform: () => {} },
    });
    const content = generateConfigContent(config);
    expect(content).toContain('  versioning: {');
    expect(content).toContain('"sources": [');
    expect(content).toContain('  endpoints: {');
    expect(content).toContain('  observability: {');
    expect(content).not.toContain('"metrics"');
  });
});

// ---------------------------------------------------------------------------
// actions/diff.ts
// ---------------------------------------------------------------------------

describe('nameSimilarity', () => {
  it('returns 1 for identical names', () => {
    expect(nameSimilarity('userName', 'userName')).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(nameSimilarity('userName', 'username')).toBe(1);
  });

  it('ignores underscores and dashes', () => {
    expect(nameSimilarity('created_at', 'createdAt')).toBe(1);
    expect(nameSimilarity('api-version', 'apiversion')).toBe(1);
  });

  it('returns 0 for disjoint names', () => {
    expect(nameSimilarity('foo', 'bar')).toBe(0);
  });

  it('returns a partial score for shared characters', () => {
    // {a,e,m,r,s,u} ∩ {a,e,i,l,m,r,s,u} over their union = 6/9
    expect(nameSimilarity('userName', 'userEmail')).toBeCloseTo(6 / 9);
  });

  it('returns NaN when both names are empty', () => {
    expect(nameSimilarity('', '')).toBeNaN();
  });
});

describe('detectRenames', () => {
  const removed = (field: string): SchemaChange => ({
    type: 'removed',
    field,
    details: 'Was: string (required)',
  });
  const added = (field: string): SchemaChange => ({
    type: 'added',
    field,
    details: 'Type: string (required)',
  });

  it('detects a simple rename', () => {
    expect(detectRenames([removed('userName')], [added('username')])).toEqual([
      {
        type: 'renamed',
        field: 'userName -> username',
        details: 'Renamed with 100% similarity',
      },
    ]);
  });

  it('detects snake_case to camelCase renames', () => {
    const renames = detectRenames([removed('created_at')], [added('createdAt')]);
    expect(renames).toHaveLength(1);
    expect(renames[0]!.field).toBe('created_at -> createdAt');
  });

  it('returns an empty list when nothing is similar enough', () => {
    expect(detectRenames([removed('userName')], [added('email')])).toEqual([]);
  });

  it('does not match at exactly 0.6 similarity (threshold is strict)', () => {
    expect(detectRenames([removed('abc')], [added('abcde')])).toEqual([]);
  });

  it('matches each removed field only once', () => {
    const renames = detectRenames([removed('userName')], [added('username'), added('user_name')]);
    expect(renames).toHaveLength(1);
    expect(renames[0]!.field).toBe('userName -> username');
  });
});

describe('compareShapes', () => {
  const field = (name: string, type = 'string', required = true): SchemaField => ({
    name,
    type,
    required,
  });
  const shape = (fields: SchemaField[]): SchemaShape => ({
    fields,
    nestedSchemas: {},
  });

  it('returns no sections for identical shapes', () => {
    const a = shape([field('id'), field('name')]);
    expect(compareShapes(a, a)).toEqual([]);
  });

  it('detects added fields', () => {
    const sections = compareShapes(
      shape([field('id')]),
      shape([field('id'), field('email', 'string', false)]),
    );
    expect(sections.map((s) => s.title)).toEqual(['Added Fields']);
    expect(sections[0]!.changes).toEqual([
      { type: 'added', field: 'email', details: 'Type: string (optional)' },
    ]);
  });

  it('detects removed fields', () => {
    const sections = compareShapes(shape([field('id'), field('name')]), shape([field('id')]));
    expect(sections.map((s) => s.title)).toEqual(['Removed Fields']);
    expect(sections[0]!.changes).toEqual([
      { type: 'removed', field: 'name', details: 'Was: string (required)' },
    ]);
  });

  it('detects changed types for same-named fields', () => {
    const sections = compareShapes(
      shape([field('age', 'number')]),
      shape([field('age', 'string')]),
    );
    expect(sections.map((s) => s.title)).toEqual(['Changed Types']);
    expect(sections[0]!.changes).toEqual([
      { type: 'changed', field: 'age', details: 'number -> string' },
    ]);
  });

  it('detects renames via the similarity heuristic', () => {
    const sections = compareShapes(shape([field('userName')]), shape([field('username')]));
    // The renamed pair also shows up as added + removed (no exclusion).
    expect(sections.map((s) => s.title)).toEqual([
      'Added Fields',
      'Removed Fields',
      'Renamed Fields',
    ]);
    const renamed = sections.find((s) => s.title === 'Renamed Fields');
    expect(renamed!.changes[0]!.field).toBe('userName -> username');
  });

  it('reports added, removed, changed, and renamed sections in a mixed diff', () => {
    const a = shape([field('id'), field('userName'), field('age', 'number')]);
    const b = shape([
      field('id'),
      field('username'),
      field('age', 'string'),
      field('email', 'string', false),
    ]);
    const sections: ChangelogSection[] = compareShapes(a, b);
    expect(sections.map((s) => s.title)).toEqual([
      'Added Fields',
      'Removed Fields',
      'Changed Types',
      'Renamed Fields',
    ]);
  });
});

describe('extractSchemaShape', () => {
  it('returns a shape when the version key matches exactly', () => {
    const config = baseConfig({
      schemas: { v1: z.object({ name: z.string() }) },
    });
    expect(extractSchemaShape(config, 'v1')).toEqual({
      fields: [],
      nestedSchemas: {},
    });
  });

  it('matches by prefix in both directions', () => {
    const config = baseConfig({
      schemas: { v1: z.object({ name: z.string() }) },
    });
    expect(extractSchemaShape(config, 'v1.5')).not.toBeNull();
  });

  it('matches a key that starts with the requested version', () => {
    const config = baseConfig({
      schemas: { 'v1.5': z.object({ name: z.string() }) },
    });
    expect(extractSchemaShape(config, 'v1')).not.toBeNull();
  });

  it('returns null when no key matches', () => {
    const config = baseConfig({
      schemas: { v1: z.object({ name: z.string() }) },
    });
    expect(extractSchemaShape(config, 'v2')).toBeNull();
  });

  it('returns null when no schemas are defined', () => {
    expect(extractSchemaShape(baseConfig(), 'v1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// actions/audit.ts
// ---------------------------------------------------------------------------

describe('scanCodebase', () => {
  it('scans route handlers and versions in source files', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'src/routes.ts',
      [
        "import { router } from './router';",
        "router.get('/v1/users', getUsers);",
        "router.post('/v2/users', createUser);",
        '',
      ].join('\n'),
    );

    const result = scanCodebase(dir);

    expect(result.totalEndpoints).toBe(1);
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({
      path: 'src/routes.ts',
      methods: ['GET', 'POST'],
      versions: ['v1', 'v2'],
    });
    expect(result.detectedVersions).toEqual(['v1', 'v2']);
    expect(result.patterns).toEqual(
      expect.arrayContaining([
        {
          type: 'route_handlers',
          count: 2,
          description: 'Route handler definitions found',
        },
      ]),
    );
  });

  it('detects version checks, headers, and switches', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'src/versioning.ts',
      [
        "if (req.headers['accept-version'] === '2.1') return;",
        "if (version === 'v1') return;",
        'switch (apiVersion) {',
        "  case 'v2': break;",
        '}',
        '',
      ].join('\n'),
    );

    const result = scanCodebase(dir);

    expect(result.detectedVersions).toEqual(['v1']);
    expect(result.patterns).toEqual(
      expect.arrayContaining([
        {
          type: 'version_headers',
          count: 1,
          description: expect.stringContaining('Version header'),
        },
        {
          type: 'version_switch',
          count: 1,
          description: expect.stringContaining('Switch statements'),
        },
      ]),
    );
  });

  it('skips node_modules, dist, and hidden directories', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src/routes.ts', "router.get('/v1/users', h);");
    writeFile(dir, 'node_modules/pkg/routes.ts', "router.get('/v9/ignored', h);");
    writeFile(dir, 'dist/routes.ts', "router.get('/v8/ignored', h);");
    writeFile(dir, '.hidden/routes.ts', "router.get('/v7/ignored', h);");

    const result = scanCodebase(dir);

    expect(result.totalEndpoints).toBe(1);
    expect(result.endpoints[0]!.path).toBe('src/routes.ts');
    expect(result.detectedVersions).toEqual(['v1']);
  });

  it('returns an empty report for a missing directory', () => {
    const dir = join(makeTempDir(), 'does-not-exist');
    const result = scanCodebase(dir);

    expect(result.totalEndpoints).toBe(0);
    expect(result.endpoints).toEqual([]);
    expect(result.detectedVersions).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.suggestions).toContain(
      'No versioning patterns detected. Consider adding explicit version management.',
    );
  });

  it('suggests centralizing version management when multiple versions exist', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.ts', "router.get('/v1/a', h);");
    writeFile(dir, 'b.ts', "router.get('/v2/b', h);");

    const result: AuditResult = scanCodebase(dir);

    expect(result.suggestions).toContain(
      'Detected 2 versions: v1, v2. Consider centralizing version management with Pylon.',
    );
  });
});

describe('generateSuggestions', () => {
  it('suggests explicit version management when none is detected', () => {
    const suggestions = generateSuggestions([], []);
    expect(suggestions).toEqual([
      'No versioning patterns detected. Consider adding explicit version management.',
      'Run "pylon init" to create a pylon.config.ts.',
    ]);
  });

  it('recommends schemas and transforms for a single version', () => {
    const suggestions = generateSuggestions([], ['v1']);
    expect(suggestions).toHaveLength(3);
    expect(suggestions).toContain(
      'Define schemas for each version to enable automatic validation.',
    );
    expect(suggestions).toContain(
      'Create transform functions between versions to handle request/response migration.',
    );
  });

  it('flags multiple detected versions', () => {
    const suggestions = generateSuggestions([], ['v1', 'v2']);
    expect(suggestions).toContain(
      'Detected 2 versions: v1, v2. Consider centralizing version management with Pylon.',
    );
  });
});

// ---------------------------------------------------------------------------
// actions/init.ts
// ---------------------------------------------------------------------------

describe('generateDefaultConfig', () => {
  it('returns a v1 semantic config', () => {
    expect(generateDefaultConfig()).toEqual({
      current: 'v1',
      versions: { format: 'semantic', prefix: 'v' },
      schemas: {},
      transforms: {},
    });
  });
});

describe('generatePresetConfig', () => {
  it('generates a semantic preset', () => {
    expect(generatePresetConfig('semantic')).toEqual({
      current: 'v3',
      versions: { format: 'semantic', prefix: 'v' },
      schemas: {},
      transforms: {},
    });
  });

  it('generates a numeric preset', () => {
    expect(generatePresetConfig('numeric')).toEqual({
      current: '3',
      versions: { format: 'numeric' },
      schemas: {},
      transforms: {},
    });
  });

  it('generates a stripe preset with today as the current version', () => {
    const config = generatePresetConfig('stripe');
    expect(config.versions).toEqual({ preset: 'stripe' });
    expect(config.current).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to the default config for unknown presets', () => {
    expect(generatePresetConfig('unknown-preset')).toEqual(generateDefaultConfig());
  });
});

describe('scanForVersions', () => {
  it('finishes scanning files containing version headers', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'src/api.ts',
      "const headers = { 'accept-version': 'v1', 'api-version': 'v2', 'x-api-version': 'v3' };",
    );
    expect(scanForVersions(dir)).toEqual([]);
  });

  it('detects version strings, api fields, and version lists', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'src/api.ts',
      [
        '// version "1.2.3"',
        "const headers = { api: 'v2' };",
        "const list = ['v3'];",
        "const body = { api: 'v4' };",
        '',
      ].join('\n'),
    );

    expect(scanForVersions(dir)).toEqual(['1.2.3', '2', '4', '3']);
  });

  it('skips node_modules and hidden directories', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src/api.ts', "const headers = { api: 'v1' };");
    writeFile(dir, 'node_modules/pkg/api.ts', "const headers = { api: 'v9' };");

    expect(scanForVersions(dir)).toEqual(['1']);
  });

  it('returns an empty list for a missing directory', () => {
    expect(scanForVersions(join(makeTempDir(), 'missing'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// actions/version.ts
// ---------------------------------------------------------------------------

describe('ensureVersionsArray', () => {
  it('passes through an existing versions array', () => {
    const versions: VersionDefinition[] = [
      { name: 'v1', order: 1 },
      { name: 'v2', order: 2 },
    ];
    const config = baseConfig({ current: 'v2', versions });
    expect(ensureVersionsArray(config)).toEqual(versions);
  });

  it('preserves all versions from a format-based config', () => {
    const config = baseConfig({
      current: 'v2',
      versions: { format: 'semantic', prefix: 'v' },
    });
    expect(ensureVersionsArray(config)).toEqual([
      { name: 'v1', order: 1 },
      { name: 'v2', order: 2 },
    ]);
  });

  it('derives a single entry from the stripe preset', () => {
    const config = baseConfig({
      current: '2026-01-01',
      versions: { preset: 'stripe' },
    });
    const versions = ensureVersionsArray(config);
    expect(versions).toHaveLength(366);
    expect(versions.at(-1)?.name).toBe('2026-01-01');
  });

  it('derives a single entry when versions is undefined', () => {
    expect(ensureVersionsArray(baseConfig({ versions: undefined }))).toEqual([
      { name: 'v2', order: 1 },
    ]);
  });
});

describe('sortVersions', () => {
  it('sorts by order ascending without mutating the input', () => {
    const input: VersionDefinition[] = [
      { name: 'v3', order: 3 },
      { name: 'v1', order: 1 },
      { name: 'v2', order: 2 },
    ];
    const sorted = sortVersions(input);
    expect(sorted.map((v) => v.name)).toEqual(['v1', 'v2', 'v3']);
    expect(input.map((v) => v.name)).toEqual(['v3', 'v1', 'v2']);
  });
});

// ---------------------------------------------------------------------------
// actions/generate.ts
// ---------------------------------------------------------------------------

describe('extractVersions', () => {
  it('extracts names from a versions array', () => {
    const config = baseConfig({
      versions: [
        { name: 'v1', order: 1 },
        { name: 'v2', order: 2 },
      ],
    });
    expect(extractVersions(config)).toEqual(['v1', 'v2']);
  });

  it('falls back to the current version for format-based configs', () => {
    expect(
      extractVersions(baseConfig({ current: 'v2', versions: { format: 'semantic' } })),
    ).toEqual(['v1', 'v2']);
  });

  it('uses current when when no versions are defined', () => {
    expect(extractVersions(baseConfig({ versions: undefined }))).toEqual(['v2']);
  });
});

describe('buildOpenAPISpec', () => {
  it('generates schema components and paths for every configured version', () => {
    const config = baseConfig({
      versions: { format: 'semantic' },
      schemas: { v1: z.object({ name: z.string() }), v2: z.object({ fullName: z.string() }) },
    });
    const spec = buildOpenAPISpec(config);
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.version).toBe('v2');
    expect(spec.components?.schemas?.v1_request.properties.name).toEqual({ type: 'string' });
    expect(spec.components?.schemas?.v2_request.properties.fullName).toEqual({ type: 'string' });
    expect(
      spec.paths['/v1/users']?.post?.requestBody?.content['application/json']?.schema.$ref,
    ).toBe('#/components/schemas/v1_request');
  });
});

describe('buildChangelog', () => {
  it('produces a placeholder changelog without schemas', () => {
    const changelog = buildChangelog('v1', 'v2', baseConfig());
    expect(changelog).toContain('## Changes');
    expect(changelog).toContain('No detailed changes detected.');
    expect(changelog).toContain('---');
    expect(changelog).toContain(
      '_This changelog was auto generated. Review and update it with manual entries._',
    );
  });

  it('mentions schema comparison when schemas exist', () => {
    const config = baseConfig({
      schemas: { v1: z.object({ name: z.string() }) },
    });
    expect(buildChangelog('v1', 'v2', config)).toContain('## Schema Changes');
  });

  it('lists transforms that involve the source or target version', () => {
    const config = baseConfig({
      transforms: { 'v1->v2': { request: (input: unknown) => input } },
    });
    const changelog = buildChangelog('v1', 'v2', config);
    expect(changelog).toContain('## Related Transforms');
    expect(changelog).toContain('- `v1->v2`');
  });

  it('omits transforms unrelated to the range', () => {
    const config = baseConfig({
      transforms: { 'v3->v4': { request: (input: unknown) => input } },
    });
    expect(buildChangelog('v1', 'v2', config)).not.toContain('## Related Transforms');
  });
});

// ---------------------------------------------------------------------------
// actions/scaffold.ts
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  it('replaces characters that are unsafe in filenames', () => {
    expect(sanitizeFilename('v1.2')).toBe('v1_2');
    expect(sanitizeFilename('2024-01-15')).toBe('2024-01-15');
    expect(sanitizeFilename('v 1')).toBe('v_1');
    expect(sanitizeFilename('stripe/preset')).toBe('stripe_preset');
  });
});

describe('detectVersions', () => {
  it('detects quoted versions, comparisons, and versioned routes', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'src/api.ts',
      [
        "const v = 'v1';",
        "if (version >= 'v2') return;",
        "const route = '/api/v3/users';",
        '',
      ].join('\n'),
    );

    // Note: the comparison pattern captures digits only, hence '2' vs 'v2'.
    expect(detectVersions(dir)).toEqual(['v1', 'v2', '2', '3']);
  });

  it('deduplicates versions within a single scan', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src/a.ts', "const v = 'v1';");
    writeFile(dir, 'src/b.ts', "const v = 'v1';");

    expect(detectVersions(dir)).toEqual(['v1']);
  });

  it('skips node_modules and returns an empty list for missing dirs', () => {
    const dir = makeTempDir();
    writeFile(dir, 'node_modules/x/api.ts', "const v = 'v9';");
    expect(detectVersions(dir)).toEqual([]);
    expect(detectVersions(join(dir, 'missing'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// actions/bench.ts
// ---------------------------------------------------------------------------

describe('createTestPayload', () => {
  it('returns a default payload when no schemas are defined', () => {
    const payload = createTestPayload(baseConfig());
    expect(payload).toMatchObject({
      id: 'test-123',
      name: 'test',
      email: 'test@example.com',
      age: 30,
      active: true,
      tags: ['a', 'b', 'c'],
    });
    expect((payload.metadata as { source: string }).source).toBe('benchmark');
    expect((payload.metadata as { timestamp: string }).timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('builds a payload keyed by schema names when schemas exist', () => {
    const config = baseConfig({
      schemas: {
        v1: z.object({ name: z.string() }),
        v2: z.object({ name: z.string(), email: z.string() }),
      },
    });
    expect(createTestPayload(config)).toEqual({
      v1: 'test_value',
      v2: 'test_value',
    });
  });
});

it('preserves format aliases when converting a config to an explicit version list', () => {
  const versions = ensureVersionsArray(
    baseConfig({ versions: { format: 'semantic', aliases: { old: 'v1', latest: 'v2' } } }),
  );
  expect(versions[0]?.aliases).toEqual(['old']);
  expect(versions[1]?.aliases).toEqual(['latest']);
});
