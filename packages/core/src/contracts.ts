import type { z } from 'zod';
import type { ContractMap, EndpointConfig, TransformErrorConfig } from './types.js';
import type { VersionNormalizer } from './version-normalizer.js';

type Schema<C, D extends 'request' | 'response'> = C extends { [K in D]: infer S }
  ? S extends z.ZodTypeAny
    ? S
    : never
  : never;
type Input<C, D extends 'request' | 'response'> = [Schema<C, D>] extends [never]
  ? undefined
  : z.input<Schema<C, D>>;
type Output<C, D extends 'request' | 'response'> = [Schema<C, D>] extends [never]
  ? undefined
  : z.output<Schema<C, D>>;
type Migration<I, O> = ((input: I) => O | Promise<O>) | ([I] extends [O] ? 'identity' : never);

export type ContractTransforms<C extends ContractMap> = {
  [K in `${keyof C & string}->${keyof C & string}` as K extends `${infer F}->${infer T}`
    ? F extends T
      ? never
      : K
    : never]?: K extends `${infer F}->${infer T}`
    ? F extends T
      ? never
      : {
          request: Migration<Output<C[F], 'request'>, Input<C[T], 'request'>>;
          response: Migration<Output<C[T], 'response'>, Input<C[F], 'response'>>;
          onError?: TransformErrorConfig;
        }
    : never;
};

export type EndpointInput<
  E extends { contracts: ContractMap },
  V extends keyof E['contracts'],
> = Output<E['contracts'][V], 'request'>;
export type EndpointOutput<
  E extends { contracts: ContractMap },
  V extends keyof E['contracts'],
> = Output<E['contracts'][V], 'response'>;

/** One operation's wire contracts. Each forward edge upgrades requests and downgrades responses. */
export function defineEndpoint<const C extends ContractMap>(
  config: Omit<EndpointConfig, 'contracts' | 'transforms' | 'method' | 'path'> & {
    method: NonNullable<EndpointConfig['method']>;
    path: string;
    contracts: C;
    transforms?: ContractTransforms<NoInfer<C>>;
  },
) {
  return config;
}

export function validateContracts(
  endpoint: EndpointConfig,
  current: string,
  normalizer: VersionNormalizer,
): string[] {
  const errors: string[] = [];
  const contracts = endpoint.contracts;
  if (!contracts) return errors;
  current = normalizer.resolveAlias(endpoint.current ?? current);
  const versions = normalizer.listVersions();
  const declared = Object.keys(contracts);
  const supported = versions.filter((v) => Object.hasOwn(contracts, v.name));
  const minimum = endpoint.minVersion ?? supported[0]?.name;
  if (!Object.hasOwn(contracts, current))
    errors.push(`Missing contract for current version "${current}"`);
  if (!minimum || !normalizer.isValid(minimum)) errors.push('Invalid or missing minimum version');
  for (const name of declared) {
    if (!normalizer.isValid(name) || normalizer.resolveAlias(name) !== name) {
      errors.push(`Contract "${name}" must use a registered canonical version name`);
      continue;
    }
    const contract = contracts[name];
    if (!contract || typeof contract !== 'object') {
      errors.push(`Contract "${name}" must be an object`);
      continue;
    }
    for (const direction of ['request', 'response'] as const) {
      const schema = contract[direction];
      if (schema !== undefined && (!schema || typeof schema.safeParseAsync !== 'function'))
        errors.push(`Contract "${name}" ${direction} must be a Zod schema`);
    }
    if (normalizer.compare(name, current) > 0)
      errors.push(`Contract "${name}" is newer than current version "${current}"`);
  }
  if (minimum && normalizer.isValid(minimum) && normalizer.isValid(current)) {
    if (normalizer.compare(minimum, current) > 0)
      errors.push('Minimum version is newer than current');
    const required = versions.filter(
      (v) => normalizer.compare(v.name, minimum) >= 0 && normalizer.compare(v.name, current) <= 0,
    );
    for (const [index, version] of required.entries()) {
      if (!Object.hasOwn(contracts, version.name))
        errors.push(`Missing contract for version "${version.name}"`);
      const next = required[index + 1];
      if (!next || endpoint.versioning === false) continue;
      const key = `${version.name}->${next.name}`;
      const pair = endpoint.transforms?.[key];
      for (const direction of ['request', 'response'] as const) {
        if (typeof pair?.[direction] !== 'function' && pair?.[direction] !== 'identity')
          errors.push(`Missing ${direction} migration "${key}"; use 'identity' if unchanged`);
      }
    }
  }
  for (const [key, pair] of Object.entries(endpoint.transforms ?? {})) {
    const [from, to, extra] = key.split('->');
    if (
      !from ||
      !to ||
      extra !== undefined ||
      !Object.hasOwn(contracts, from) ||
      !Object.hasOwn(contracts, to)
    ) {
      errors.push(`Migration "${key}" must reference declared contracts`);
      continue;
    }
    if (normalizer.normalize(to) !== (normalizer.normalize(from) ?? 0) + 1)
      errors.push(`Migration "${key}" must connect adjacent releases in forward order`);
    if (pair.onError && ['passthrough', 'log-and-continue'].includes(pair.onError.strategy))
      errors.push(`Migration "${key}" cannot bypass contract validation on error`);
  }
  return errors;
}

/** Compile once; parameter segments use the same :name notation as framework routers. */
export function routePattern(path: string): RegExp {
  return new RegExp(
    `^${path
      .split('/')
      .map((part) =>
        /^:[A-Za-z_][\w]*$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('/')
      .replace(/\/$/, '')}/?$`,
  );
}
