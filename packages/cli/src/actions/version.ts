import type { PylonConfig, VersionDefinition } from '@ossl/pylon-core';
import { VersionNormalizer } from '@ossl/pylon-core';
import { loadPylonConfig, writeConfig } from '../load-config.js';

/** Expand formats while preserving every supported version. */
export function ensureVersionsArray(config: PylonConfig): VersionDefinition[] {
  const normalizer = new VersionNormalizer(config.versions, config.current);
  const versions = normalizer.listVersions().map((version) => ({
    ...version,
    ...(version.aliases ? { aliases: [...version.aliases] } : {}),
  }));
  if (config.versions && !Array.isArray(config.versions) && 'aliases' in config.versions) {
    for (const [alias, target] of Object.entries(config.versions.aliases ?? {})) {
      const version = versions.find((version) => version.name === normalizer.resolveAlias(target));
      if (version) version.aliases = [...(version.aliases ?? []), alias];
    }
  }
  return versions;
}

/**
 * Sort versions by their order field.
 */
export function sortVersions(versions: VersionDefinition[]): VersionDefinition[] {
  return [...versions].sort((a, b) => a.order - b.order);
}

/**
 * List all versions.
 */
export async function versionListAction(): Promise<void> {
  const { config } = await loadPylonConfig();
  const versions = ensureVersionsArray(config);

  if (versions.length === 0) {
    console.log('No versions defined.');
    return;
  }

  const sorted = sortVersions(versions);
  const today = new Date().toISOString().split('T')[0] ?? '';

  console.log('Versions:');
  for (const v of sorted) {
    const isCurrent = v.name === config.current;
    const markers: string[] = [];
    if (isCurrent) markers.push('current');
    if (v.deprecated) markers.push('deprecated');
    if (v.retired) markers.push('retired');
    else if (v.unpublished) markers.push('unpublished');
    if (v.sunsetDate && v.sunsetDate <= today) markers.push('sunset');

    const tag = markers.length > 0 ? ` (${markers.join(', ')})` : '';
    const sunsetStr = v.sunsetDate ? `  sunset: ${v.sunsetDate}` : '';
    console.log(`  ${v.name}${tag}`);
    if (sunsetStr) console.log(`    ${sunsetStr}`);
  }
}

/**
 * Show the current version.
 */
export async function versionCurrentAction(): Promise<void> {
  const { config } = await loadPylonConfig();
  console.log(config.current);
}

/**
 * Add a new version.
 *
 * Contract projects must define the new schemas and migrations before changing current.
 */
export async function versionAddAction(name: string): Promise<void> {
  const { config, configPath } = await loadPylonConfig();
  const versions = ensureVersionsArray(config);

  // Check for duplicates
  if (versions.some((v) => v.name === name)) {
    console.error(`Version "${name}" already exists.`);
    process.exit(1);
  }

  const maxOrder = versions.reduce((max, v) => Math.max(max, v.order), 0);
  const newVersion: VersionDefinition = {
    name,
    order: maxOrder + 1,
  };

  versions.push(newVersion);

  const updatedConfig: PylonConfig = {
    ...config,
    current: name,
    versions,
  };

  await writeConfig(configPath, updatedConfig);
  console.log(`Added version "${name}".`);
  console.log(`Run "pylon schema show ${name}" to see the schema.`);
}

/**
 * Mark a version as deprecated.
 */
export async function versionDeprecateAction(name: string): Promise<void> {
  const { config, configPath } = await loadPylonConfig();
  const versions = ensureVersionsArray(config);

  const version = versions.find((v) => v.name === name);
  if (!version) {
    console.error(`Version "${name}" not found.`);
    process.exit(1);
  }

  version.deprecated = true;

  const updatedConfig: PylonConfig = {
    ...config,
    versions,
  };

  await writeConfig(configPath, updatedConfig);
  console.log(`Marked version "${name}" as deprecated.`);
}

/**
 * Set a sunset date for a version.
 */
export async function versionSunsetAction(name: string, options: { date?: string }): Promise<void> {
  const { config, configPath } = await loadPylonConfig();
  const versions = ensureVersionsArray(config);

  const version = versions.find((v) => v.name === name);
  if (!version) {
    console.error(`Version "${name}" not found.`);
    process.exit(1);
  }

  if (!options.date) {
    // Default to 90 days from now
    const date = new Date();
    date.setDate(date.getDate() + 90);
    version.sunsetDate = date.toISOString().split('T')[0];
  } else {
    // Validate date format
    const parsed = new Date(options.date);
    if (isNaN(parsed.getTime())) {
      console.error(`Invalid date "${options.date}". Use ISO format (YYYY-MM-DD).`);
      process.exit(1);
    }
    version.sunsetDate = options.date;
  }

  version.deprecated = true;

  const updatedConfig: PylonConfig = {
    ...config,
    versions,
  };

  await writeConfig(configPath, updatedConfig);
  console.log(`Version "${name}" sunset set to ${version.sunsetDate}.`);
}

/**
 * Unpublish (emergency rollback) a version.
 *
 * Reject requests after reload without changing the current implementation.
 */
export async function versionUnpublishAction(name: string): Promise<void> {
  const { config, configPath } = await loadPylonConfig();
  const versions = ensureVersionsArray(config);
  const version = versions.find((v) => v.name === name);
  if (!version) throw new Error(`Version "${name}" not found.`);
  version.unpublished = true;
  await writeConfig(configPath, { ...config, versions });
  console.log(`Unpublished version "${name}". Requests return 410 after config reload.`);
}

/**
 * Re-publish a version after a fix.
 */
export async function versionPublishAction(name: string): Promise<void> {
  const { config, configPath } = await loadPylonConfig();
  const versions = ensureVersionsArray(config);
  const version = versions.find((v) => v.name === name);
  if (!version) throw new Error(`Version "${name}" not found.`);
  if (version.retired) throw new Error(`Cannot publish permanently retired version: "${name}"`);
  version.unpublished = false;
  await writeConfig(configPath, { ...config, versions });
  console.log(`Published version "${name}". Current implementation remains "${config.current}".`);
}

/**
 * Permanently reject a version while retaining migration history.
 */
export async function versionRetireAction(name: string): Promise<void> {
  const { config, configPath } = await loadPylonConfig();
  const versions = ensureVersionsArray(config);
  const version = versions.find((v) => v.name === name);
  if (!version) throw new Error(`Version "${name}" not found.`);
  version.retired = true;
  version.unpublished = true;
  version.deprecated = true;
  await writeConfig(configPath, { ...config, versions });
  console.log(`Retired version "${name}". Migration history retained.`);
}
