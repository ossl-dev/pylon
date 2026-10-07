import type { Pylon } from '@ossl/pylon-core';
import { z } from 'zod';
import type {
  OpenAPIGenerateOptions,
  OpenAPISpec,
  ParameterObject,
  PathItem,
  SchemaObject,
} from './types.js';

/** Uses Zod's public JSON Schema exporter; unsupported wire types fail explicitly. */
export function zodToOpenAPISchema(
  schema: z.ZodTypeAny,
  io: 'input' | 'output' = 'input',
): SchemaObject {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io });
  delete json.$schema;
  return json as SchemaObject;
}

function rebaseRefs(schema: SchemaObject, base: string): SchemaObject {
  const pending: unknown[] = [schema];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const object = node as Record<string, unknown>;
    if (typeof object.$ref === 'string' && object.$ref.startsWith('#'))
      object.$ref = base + object.$ref.slice(1);
    pending.push(...Object.values(object));
  }
  return schema;
}

function requiresBody(schema: z.ZodTypeAny): boolean {
  const wrapper = z.toJSONSchema(z.object({ body: schema }), { io: 'input' });
  return wrapper.required?.includes('body') ?? false;
}

/** Schemas contain no route information. Retained for callers of the original helper. */
export function inferPathsFromSchemas(
  _schemas?: Record<string, z.ZodTypeAny>,
  _versions?: string[],
  _normalizer?: unknown,
): Record<string, Record<string, PathItem>> {
  return {};
}

/** Generate real operations; multiple versions use anyOf plus an explicit version-to-schema map. */
export function generateOpenAPI(pylon: Pylon, options: OpenAPIGenerateOptions = {}): OpenAPISpec {
  const versions = [
    ...new Set(
      (options.versions ?? pylon.normalizer.listVersions().map((v) => v.name)).map((version) => {
        if (!pylon.normalizer.isValid(version))
          throw new Error(`Unknown OpenAPI version: "${version}"`);
        return pylon.normalizer.resolveAlias(version);
      }),
    ),
  ];
  const components: Record<string, SchemaObject> = {};
  const spec: OpenAPISpec = {
    openapi: '3.1.0',
    info: {
      title: 'API',
      version: versions.length === 1 ? versions[0]! : pylon.current,
      ...options.info,
    },
    ...(options.servers ? { servers: options.servers } : {}),
    paths: {},
    components: {
      schemas: components,
      ...(options.securitySchemes ? { securitySchemes: options.securitySchemes } : {}),
    },
  };
  // Legacy global schemas still export components, without fabricating HTTP routes.
  for (const version of versions) {
    const schema = pylon.config.schemas[version];
    if (schema) components[`${version}_request`] = zodToOpenAPISchema(schema);
  }
  for (const [index, [name, endpoint]] of Object.entries(pylon.config.endpoints ?? {}).entries()) {
    if (!endpoint.contracts || !endpoint.method || !endpoint.path) continue;
    const supported = versions.filter(
      (version) =>
        Object.hasOwn(endpoint.contracts!, version) &&
        (endpoint.versioning !== false || version === (endpoint.current ?? pylon.current)),
    );
    if (!supported.length) continue;
    const parameters: ParameterObject[] = [];
    const path = endpoint.path.replace(/:([A-Za-z_][\w]*)/g, (_, param: string) => {
      parameters.push({ name: param, in: 'path', required: true, schema: { type: 'string' } });
      return `{${param}}`;
    });
    const source =
      pylon.config.versioning?.sources.find((s) => s.type === 'header' || s.type === 'query') ??
      (pylon.config.versioning ? undefined : { type: 'header' as const, name: 'api-version' });
    if (source && endpoint.versioning !== false)
      parameters.push({
        name: source.name ?? 'api_version',
        in: source.type as 'header' | 'query',
        required: pylon.config.versioning?.onMissing === 'reject',
        schema: { type: 'string', enum: supported, default: pylon.defaultVersion },
      });
    const contracts: NonNullable<PathItem['x-pylon-contracts']> = Object.create(null);
    const requests: SchemaObject[] = [];
    const responses: SchemaObject[] = [];
    for (const version of supported) {
      const refs: { request?: SchemaObject; response?: SchemaObject } = {};
      for (const direction of ['request', 'response'] as const) {
        const schema = endpoint.contracts[version]?.[direction];
        if (!schema) continue;
        const key = `${name.replace(/[^\w.-]/g, '_')}_${index}_${pylon.normalizer.normalize(version)}_${direction}`;
        const ref = `#/components/schemas/${key}`;
        try {
          components[key] = rebaseRefs(
            zodToOpenAPISchema(schema, direction === 'request' ? 'input' : 'output'),
            ref,
          );
        } catch (error) {
          throw new Error(
            `Cannot export ${name} ${version} ${direction}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        refs[direction] = { $ref: ref };
        (direction === 'request' ? requests : responses).push(refs[direction]);
      }
      contracts[version] = refs;
    }
    const shape = (refs: SchemaObject[]): SchemaObject =>
      refs.length === 1 ? refs[0]! : { anyOf: refs };
    const operation: PathItem = {
      operationId: `${name.replace(/[^\w]/g, '_')}_${index}`,
      parameters,
      ...(requests.length
        ? {
            requestBody: {
              required: supported.every((version) => {
                const schema = endpoint.contracts![version]?.request;
                return schema !== undefined && requiresBody(schema);
              }),
              content: { 'application/json': { schema: shape(requests) } },
            },
          }
        : {}),
      responses: {
        [endpoint.status ?? 200]: {
          description: 'Successful response',
          ...(responses.length
            ? { content: { 'application/json': { schema: shape(responses) } } }
            : {}),
        },
      },
      ...(supported.every((v) => pylon.isDeprecated(v)) ? { deprecated: true } : {}),
      'x-pylon-contracts': contracts,
    };
    spec.paths[path] ??= {};
    spec.paths[path]![endpoint.method.toLowerCase()] = operation;
  }
  return spec;
}

export function generateOpenAPIVersions(
  pylon: Pylon,
  options: Omit<OpenAPIGenerateOptions, 'versions'> = {},
): Record<string, OpenAPISpec> {
  return Object.fromEntries(
    pylon.normalizer
      .listVersions()
      .map((v) => [v.name, generateOpenAPI(pylon, { ...options, versions: [v.name] })]),
  );
}
