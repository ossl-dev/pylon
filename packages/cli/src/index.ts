#!/usr/bin/env node
import { Command } from 'commander';
import { auditAction } from './actions/audit.js';
import { benchAction } from './actions/bench.js';
import { diffAction } from './actions/diff.js';
import { generateChangelogAction, generateOpenAPIAction } from './actions/generate.js';
import { initAction } from './actions/init.js';
import { playgroundAction } from './actions/playground.js';
import { scaffoldAction } from './actions/scaffold.js';
import { schemaDiffAction, schemaShowAction, schemaValidateAction } from './actions/schema.js';
import {
  transformComposeAction,
  transformGraphAction,
  transformShowAction,
} from './actions/transform.js';
import {
  versionAddAction,
  versionCurrentAction,
  versionDeprecateAction,
  versionListAction,
  versionPublishAction,
  versionRetireAction,
  versionSunsetAction,
  versionUnpublishAction,
} from './actions/version.js';

const program = new Command();

program.name('pylon').description('API versioning toolkit').version('0.0.1');

program
  .command('init')
  .description('Create pylon.config.ts interactively')
  .option('--preset <name>', 'Use versioning preset')
  .option('--from-existing <path>', 'Analyze existing codebase')
  .action(async (options) => {
    await initAction(options);
  });

const versionCmd = program.command('version').description('Manage API versions');
versionCmd
  .command('list')
  .description('List all versions')
  .action(async () => {
    await versionListAction();
  });
versionCmd
  .command('current')
  .description('Show current version')
  .action(async () => {
    await versionCurrentAction();
  });
versionCmd
  .command('add <name>')
  .description('Add new version')
  .action(async (name: string) => {
    await versionAddAction(name);
  });
versionCmd
  .command('deprecate <name>')
  .description('Mark version deprecated')
  .action(async (name: string) => {
    await versionDeprecateAction(name);
  });
versionCmd
  .command('sunset <name>')
  .description('Set sunset date')
  .option('--date <date>', 'Sunset date')
  .action(async (name: string, options: { date?: string }) => {
    await versionSunsetAction(name, options);
  });
versionCmd
  .command('unpublish <name>')
  .description('Emergency rollback')
  .action(async (name: string) => {
    await versionUnpublishAction(name);
  });
versionCmd
  .command('publish <name>')
  .description('Re-publish after fix')
  .action(async (name: string) => {
    await versionPublishAction(name);
  });
versionCmd
  .command('retire <name>')
  .description('Permanently remove')
  .action(async (name: string) => {
    await versionRetireAction(name);
  });

const schemaCmd = program.command('schema').description('Manage schemas');
schemaCmd
  .command('show <version>')
  .description('Print schema')
  .action(async (version: string) => {
    await schemaShowAction(version);
  });
schemaCmd
  .command('diff <a> <b>')
  .description('Show schema diff')
  .action(async (a: string, b: string) => {
    await schemaDiffAction(a, b);
  });
schemaCmd
  .command('validate <version>')
  .description('Validate schema')
  .action(async (version: string) => {
    await schemaValidateAction(version);
  });

const transformCmd = program.command('transform').description('Manage transforms');
transformCmd
  .command('show <key>')
  .description('Show composed transform')
  .action(async (key: string) => {
    await transformShowAction(key);
  });
transformCmd
  .command('graph')
  .description('Show version graph')
  .action(async () => {
    await transformGraphAction();
  });
transformCmd
  .command('compose <source> <target>')
  .description('Compose transform chain')
  .action(async (source: string, target: string) => {
    await transformComposeAction(source, target);
  });

program
  .command('audit')
  .description('Analyze codebase for versioning patterns')
  .argument('[path]', 'Source path', './src')
  .action(async (path: string) => {
    await auditAction(path);
  });
program
  .command('diff')
  .description('Generate changelog between versions')
  .argument('<a>', 'Source version')
  .argument('<b>', 'Target version')
  .action(async (a: string, b: string) => {
    await diffAction(a, b);
  });

const generateCmd = program.command('generate').description('Generate artifacts');
generateCmd
  .command('openapi')
  .description('Generate OpenAPI spec')
  .option('-o, --output <path>', 'Output path')
  .action(async (options: { output?: string }) => {
    await generateOpenAPIAction(options);
  });
generateCmd
  .command('changelog <range>')
  .description('Generate changelog')
  .action(async (range: string) => {
    await generateChangelogAction(range);
  });

program
  .command('scaffold')
  .description('Generate transforms from code analysis')
  .argument('<path>', 'Source path')
  .option('-o, --output <path>', 'Output path')
  .action(async (path: string, options: { output?: string }) => {
    await scaffoldAction(path, options);
  });
program
  .command('playground')
  .description('Start Transform Playground web UI')
  .option('-p, --port <number>', 'Port', '3000')
  .action(async (options: { port: string }) => {
    await playgroundAction(options);
  });
program
  .command('bench')
  .description('Benchmark transform performance')
  .argument('<source>', 'Source version')
  .argument('<target>', 'Target version')
  .option('-n, --iterations <number>', 'Iterations', '1000')
  .action(async (source: string, target: string, options: { iterations: string }) => {
    await benchAction(source, target, { iterations: parseInt(options.iterations, 10) || 1000 });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
