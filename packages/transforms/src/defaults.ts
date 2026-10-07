import { setOwnProperty } from './object.js';
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
  seen = new WeakMap<object, WeakMap<object, Record<string, unknown>>>(),
): Record<string, any> {
  if (!isObject(obj) || !isObject(defaults) || depth >= maxDepth) {
    return { ...obj };
  }

  const cached = seen.get(obj)?.get(defaults);
  if (cached) return cached;
  const result: Record<string, any> = { ...obj };
  let pairs = seen.get(obj);
  if (!pairs) {
    pairs = new WeakMap();
    seen.set(obj, pairs);
  }
  pairs.set(defaults, result);

  for (const key of Object.keys(defaults)) {
    const defaultVal = defaults[key];
    const objVal = Object.hasOwn(result, key) ? result[key] : undefined;

    if (objVal === undefined || (deepFill && objVal === null)) {
      setOwnProperty(result, key, deepClone(defaultVal));
    } else if (isObject(objVal) && isObject(defaultVal)) {
      setOwnProperty(
        result,
        key,
        mergeDefaults(objVal, defaultVal, maxDepth, depth + 1, deepFill, seen),
      );
    }
  }

  return result;
}

function isObject(val: unknown): val is Record<string, any> {
  return (
    val !== null &&
    typeof val === 'object' &&
    (Object.getPrototypeOf(val) === Object.prototype || Object.getPrototypeOf(val) === null)
  );
}

function deepClone<T>(val: T, seen = new WeakMap<object, unknown>()): T {
  if (val instanceof Date) return new Date(val.getTime()) as T;
  if (!Array.isArray(val) && !isObject(val)) return val;
  const cached = seen.get(val);
  if (cached) return cached as T;
  const result: Record<string, unknown> | unknown[] = Array.isArray(val) ? [] : {};
  seen.set(val, result);
  for (const key of Object.keys(val)) {
    setOwnProperty(
      result as Record<string, unknown>,
      key,
      deepClone((val as Record<string, unknown>)[key], seen),
    );
  }
  return result as T;
}
