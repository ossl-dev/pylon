import { readFileSync } from 'node:fs';
import { Pylon, type PylonConfig } from '@ossl/pylon-core';
import { zodToOpenAPISchema } from '@ossl/pylon-openapi';
import { loadPylonConfig } from '../load-config.js';

export interface SchemaOptions {
  endpoint?: string;
  direction?: 'request' | 'response';
  input?: string;
}

export function selectSchema(config: PylonConfig, version: string, options: SchemaOptions = {}) {
  const root = new Pylon(config);
  const pylon = options.endpoint ? root.forEndpoint(options.endpoint) : root;
  if (!options.endpoint && Object.values(config.endpoints ?? {}).some((e) => e.contracts))
    throw new Error('Select a contract with --endpoint <name>');
  version = pylon.normalizer.resolveAlias(version);
  if (!pylon.normalizer.isValid(version)) throw new Error(`Unknown version: "${version}"`);
  const direction = options.direction ?? 'request';
  if (direction !== 'request' && direction !== 'response')
    throw new Error('Direction must be request or response');
  const schema = pylon.config.contracts?.[version]?.[direction] ?? pylon.config.schemas[version];
  if (!schema) throw new Error(`No ${direction} schema for version "${version}"`);
  return { schema, direction };
}

export async function schemaShowAction(
  version: string,
  options: SchemaOptions = {},
): Promise<void> {
  const { config } = await loadPylonConfig();
  const { schema, direction } = selectSchema(config, version, options);
  console.log(
    JSON.stringify(
      zodToOpenAPISchema(schema, direction === 'request' ? 'input' : 'output'),
      null,
      2,
    ),
  );
}

export async function schemaValidateAction(
  version: string,
  options: SchemaOptions = {},
): Promise<void> {
  const { config } = await loadPylonConfig();
  const { schema, direction } = selectSchema(config, version, options);
  if (options.input) await schema.parseAsync(JSON.parse(readFileSync(options.input, 'utf8')));
  else zodToOpenAPISchema(schema, direction === 'request' ? 'input' : 'output');
  console.log(`${version} ${direction}: valid${options.input ? ' fixture' : ' JSON schema'}`);
}
