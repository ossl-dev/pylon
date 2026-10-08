#!/usr/bin/env node
import { Command } from 'commander';
import { auditAction } from './actions/audit.js';
import type { BenchOptions } from './actions/bench.js';
import { benchAction } from './actions/bench.js';
import { diffAction } from './actions/diff.js';
import { doctorAction } from './actions/doctor.js';
import { generateChangelogAction, generateOpenAPIAction } from './actions/generate.js';
import { initAction } from './actions/init.js';
import { playgroundAction } from './actions/playground.js';
import { scaffoldAction } from './actions/scaffold.js';
import { schemaShowAction, schemaValidateAction } from './actions/schema.js';
import {
  transformComposeAction,
  transformGraphAction,
  transformRunAction,
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
  .command('doctor')
  .description('Validate contracts, configuration, and migration paths')
  .option('--json', 'Print machine-readable results')
  .action(doctorAction);

program
  .command('init')
  .description('Create contracts and a runnable two-version example')
  .option('--preset <name>', 'Use versioning preset')
  .option('--from-existing <path>', 'Analyze existing codebase')
  .option('--no-example', 'Create config only')
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
  .description('Permanently reject requests; retain migration history')
  .action(async (name: string) => {
    await versionRetireAction(name);
  });

const schemaCmd = program.command('schema').description('Inspect versioned contracts');
function schemaOptions(command: Command): Command {
  return command
    .option('--endpoint <name>', 'Select endpoint contract')
    .option('--direction <direction>', 'request or response', 'request');
}
schemaOptions(schemaCmd.command('show <version>').description('Print JSON schema')).action(
  schemaShowAction,
);
schemaOptions(schemaCmd.command('diff <a> <b>').description('Compare JSON schema assertions'))
  .option('--json', 'Print machine-readable changes')
  .action(diffAction);
schemaOptions(
  schemaCmd.command('validate <version>').description('Validate schema or JSON fixture'),
)
  .option('--input <file>', 'JSON fixture to parse against the schema')
  .action(schemaValidateAction);

const transformCmd = program.command('transform').description('Manage transforms');
function transformOptions(command: Command): Command {
  return command
    .option('--endpoint <name>', 'Select endpoint contract')
    .option('--json', 'Print machine-readable results');
}
transformOptions(transformCmd.command('show <key>').description('Inspect a migration chain'))
  .option('--direction <direction>', 'request or response', 'request')
  .action(transformShowAction);
transformOptions(
  transformCmd.command('graph').description('Show registered migration paths'),
).action(transformGraphAction);
transformOptions(
  transformCmd.command('compose <source> <target>').description('Inspect a composed chain'),
)
  .option('--direction <direction>', 'request or response', 'request')
  .action(transformComposeAction);
transformOptions(
  transformCmd
    .command('run <source> <target>')
    .description('Dry-run a fixture with hop snapshots; executes user migrations locally'),
)
  .requiredOption('--input <file>', 'JSON fixture')
  .option('--direction <direction>', 'request or response', 'request')
  .action(transformRunAction);

program
  .command('audit')
  .description('Analyze codebase for versioning patterns')
  .argument('[path]', 'Source path', './src')
  .action(async (path: string) => {
    await auditAction(path);
  });
schemaOptions(program.command('diff <a> <b>').description('Compare versioned contract schemas'))
  .option('--json', 'Print machine-readable changes')
  .action(diffAction);

const generateCmd = program.command('generate').description('Generate artifacts');
generateCmd
  .command('openapi')
  .description('Generate OpenAPI spec')
  .option('-o, --output <path>', 'Output path')
  .option('--version <name>', 'Export one published version')
  .option('--all-versions', 'Export separate specs; output is a directory')
  .action(async (options: { output?: string; version?: string; allVersions?: boolean }) => {
    await generateOpenAPIAction(options);
  });
generateCmd
  .command('changelog <range>')
  .description('Generate declared contract changes')
  .option('-o, --output <path>', 'Write changelog to a file')
  .option('--json', 'Print machine-readable contract changes')
  .action(generateChangelogAction);

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
  .description('Benchmark real JSON fixtures and contract processing')
  .argument('<source>', 'Source version')
  .argument('<target>', 'Target version')
  .option('-n, --iterations <number>', 'Iterations', '1000')
  .requiredOption('--input <path>', 'Request fixture in source wire format')
  .option('--response <path>', 'Current response fixture for pipeline mode')
  .option('--endpoint <name>', 'Endpoint contract to benchmark')
  .option('--mode <name>', 'transform or pipeline', 'transform')
  .option('--json', 'Print machine-readable results')
  .action(async (source: string, target: string, options: BenchOptions) => {
    await benchAction(source, target, options);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
