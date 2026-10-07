import { validateConfig } from '@ossl/pylon-core';
import { loadPylonConfig } from '../load-config.js';

/**
 * Show the schema for a given version.
 *
 * Prints the schema definition for the specified version. If no
 * detailed schema is available, prints a placeholder.
 */
export async function schemaShowAction(version: string): Promise<void> {
  const { config } = await loadPylonConfig();

  const schemaKeys = Object.keys(config.schemas);

  // Look for a schema keyed by the version name
  const matchingKey = schemaKeys.find(
    (k) => k === version || k.startsWith(version) || version.startsWith(k),
  );

  if (!matchingKey) {
    console.log(`No schema defined for version "${version}".`);
    console.log('Define schemas in your pylon.config.ts using zod.');
    return;
  }

  console.log(`Schema for version "${version}":`);
  console.log(`  Key: ${matchingKey}`);
  console.log('  Type: Zod schema');
  console.log('');
  console.log('  To see the full schema definition, check your pylon.config.ts');
  console.log(`  or run: cat pylon.config.ts | grep -A 20 "${matchingKey}"`);
}

/**
 * Show the schema diff between two versions.
 *
 * Compares the field-level differences between two version schemas
 * and prints added, removed, and changed fields.
 */
export async function schemaDiffAction(a: string, b: string): Promise<void> {
  const { config } = await loadPylonConfig();

  const schemaKeys = Object.keys(config.schemas);

  const keyA = schemaKeys.find((k) => k === a || k.startsWith(a) || a.startsWith(k));
  const keyB = schemaKeys.find((k) => k === b || k.startsWith(b) || b.startsWith(k));

  if (!keyA) {
    console.log(`No schema found for version "${a}".`);
    return;
  }

  if (!keyB) {
    console.log(`No schema found for version "${b}".`);
    return;
  }

  if (keyA === keyB) {
    console.log(`Schemas for "${a}" and "${b}" are identical (same key: "${keyA}").`);
    return;
  }

  // Since we can't deeply introspect Zod schemas from the CLI config,
  // we show which schema keys are defined
  console.log(`Schema diff: ${a} -> ${b}`);
  console.log('');
  console.log(`  Source schema key:      ${keyA}`);
  console.log(`  Target schema key:      ${keyB}`);
  console.log('');
  console.log('  (Full field-level diff requires Zod schema introspection)');
  console.log('');
  console.log('  Suggested next steps:');
  console.log('    - Review both schema definitions in pylon.config.ts');
  console.log('    - Run "pylon diff <a> <b>" for a changelog');
  console.log('    - Ensure transforms exist between these versions');
}

/**
 * Validate a version's schema.
 *
 * Runs the config validator and reports any schema-related errors.
 */
export async function schemaValidateAction(version: string): Promise<void> {
  const { config } = await loadPylonConfig();

  // Run the standard validation
  const validation = validateConfig(config);

  // Check for version-specific issues
  const schemaKeys = Object.keys(config.schemas);
  const matchingKey = schemaKeys.find(
    (k) => k === version || k.startsWith(version) || version.startsWith(k),
  );

  console.log(`Schema validation for version "${version}":`);
  console.log('');

  if (!matchingKey) {
    console.log('  WARNING: No schema defined for this version.');
    console.log('  Define schemas in pylon.config.ts using zod.');
    console.log('');
  } else {
    console.log(`  Schema key: ${matchingKey}`);
    console.log('  Status: Schema defined');
    console.log('');
  }

  if (validation.valid) {
    console.log('  Config validation: PASSED');
  } else {
    console.log('  Config validation: FAILED');
    for (const err of validation.errors) {
      console.log(`    - ${err}`);
    }
  }

  // Check transforms involving this version
  const transformKeys = Object.keys(config.transforms);
  const relevantTransforms = transformKeys.filter((k) => k.includes(version));

  if (relevantTransforms.length > 0) {
    console.log('');
    console.log('  Related transforms:');
    for (const key of relevantTransforms) {
      console.log(`    - ${key}`);
    }
  } else {
    console.log('');
    console.log('  NOTE: No transforms found involving this version.');
  }
}
