import { defineConfig, validateConfig } from './config.js';
import { mergeConfigs } from './endpoint.js';
import { TransformEngine } from './transform-engine.js';
import type { PylonOptions } from './types.js';
import { VersionNormalizer } from './version-normalizer.js';

export interface ConfigAudit {
  valid: boolean;
  errors: string[];
  warnings: string[];
  versions: string[];
  endpoints: string[];
}

/** Audit startup contracts and legacy paths without executing user migrations. */
export function auditConfig(options: PylonOptions): ConfigAudit {
  const config = defineConfig(options);
  const validation = validateConfig(config);
  const errors = new Set(validation.errors);
  const warnings = new Set<string>();
  const versions: string[] = [];
  const endpoints = Object.keys(config.endpoints ?? {});
  if (validation.valid) {
    try {
      const normalizer = new VersionNormalizer(config.versions, config.current);
      versions.push(...normalizer.listVersions().map((v) => v.name));
      if (!normalizer.isValid(config.current))
        errors.add(`Unknown current version: "${config.current}"`);
      if (!normalizer.isValid(config.defaultVersion ?? config.current))
        errors.add(`Unknown default version: "${config.defaultVersion}"`);
      const scopes = config.contracts ? [] : [{ name: 'global', config }];
      for (const [name, endpoint] of Object.entries(config.endpoints ?? {})) {
        if (!endpoint.contracts && endpoint.versioning !== false)
          scopes.push({ name, config: mergeConfigs(config, endpoint) });
      }
      for (const scope of scopes) {
        const engine = new TransformEngine(
          scope.config.transforms,
          scope.config.schemas,
          normalizer,
        );
        for (const key of Object.keys(scope.config.schemas)) {
          if (!normalizer.isValid(key))
            errors.add(`${scope.name}: schema refers to unknown version "${key}"`);
        }
        // A contract-only project has no global body migrations.
        if (
          scope.name === 'global' &&
          !Object.keys(scope.config.schemas).length &&
          !Object.keys(scope.config.transforms).length &&
          endpoints.length
        )
          continue;
        for (const version of versions) {
          for (const [from, to, direction] of [
            [version, scope.config.current, 'request'],
            [scope.config.current, version, 'response'],
          ] as const) {
            try {
              for (const key of engine.buildChain(from, to)) {
                if (!scope.config.transforms[key]?.[direction])
                  warnings.add(
                    `${scope.name}: "${key}" has implicit ${direction} identity; declare 'identity' explicitly`,
                  );
              }
            } catch (error) {
              errors.add(
                `${scope.name}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
        for (const key of Object.keys(scope.config.transforms)) {
          const [from, to] = key.split('->');
          if (!normalizer.isValid(from ?? '') || !normalizer.isValid(to ?? ''))
            errors.add(`${scope.name}: migration "${key}" references an unknown version`);
        }
      }
    } catch (error) {
      errors.add(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    valid: errors.size === 0,
    errors: [...errors],
    warnings: [...warnings],
    versions,
    endpoints,
  };
}
