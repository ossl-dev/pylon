import type { DefaultsOptions } from './types.js';

/**
 * Deep-merge defaults into an object. Only fills missing (undefined/null) fields.
 * Returns new object, does not mutate original.
 * This is THE critical utility for request transforms - it ensures every field
 * the current version requires has a sensible default for older versions.
 *
 * @example
 * defaults(
 *   { name: 'John', address: { street: '123 Main' } },
 *   { email: 'unknown@example.com', address: { country: 'US' } }
 * )
 * // => { name: 'John', address: { street: '123 Main', country: 'US' }, email: 'unknown@example.com' }
 *
 * Handles:
 * - Deep merging (objects within objects)
 * - Arrays: replaces entirely (does not merge)
 * - null/undefined first arg returns deep clone of defaults
 * - Null/undefined defaults fields pass through
 * - Does not override existing truthy values
 * - Max depth option prevents infinite recursion
 */
export function defaults<T extends Record<string, any>, D extends Record<string, any>>(
  obj: T | null | undefined,
  defaultValues: D,
  options?: DefaultsOptions,
): T & D;
export function defaults<T, D>(obj: T, defaultValues: D, options?: DefaultsOptions): T | D;
export function defaults(
  obj: Record<string, any> | null | undefined,
  defaultValues: Record<string, any>,
  options?: DefaultsOptions,
): Record<string, any> {
  const maxDepth = options?.maxDepth ?? Number.POSITIVE_INFINITY;
  const deepFill = options?.deepFill ?? false;

  if (obj == null) {
    return deepClone(defaultValues);
  }
  if (defaultValues == null) {
    return { ...obj };
  }

  return mergeDefaults(obj, defaultValues, maxDepth, 0, deepFill);
}

function mergeDefaults(
  obj: Record<string, any>,
  defaults: Record<string, any>,
  maxDepth: number,
  depth: number,
  deepFill: boolean,
): Record<string, any> {
  if (!isObject(obj) || !isObject(defaults) || depth >= maxDepth) {
    return { ...obj };
  }

  const result: Record<string, any> = { ...obj };

  for (const key of Object.keys(defaults)) {
    const defaultVal = defaults[key];
    const objVal = result[key];

    if (objVal === undefined || (deepFill && objVal === null)) {
      result[key] = deepClone(defaultVal);
    } else if (isObject(objVal) && isObject(defaultVal)) {
      result[key] = mergeDefaults(objVal, defaultVal, maxDepth, depth + 1, deepFill);
    }
  }

  return result;
}

function isObject(val: unknown): val is Record<string, any> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function deepClone<T>(val: T): T {
  if (Array.isArray(val)) {
    return val.map(deepClone) as unknown as T;
  }
  if (isObject(val)) {
    const result: Record<string, any> = {};
    for (const key of Object.keys(val)) {
      result[key] = deepClone(val[key]);
    }
    return result as T;
  }
  return val;
}
