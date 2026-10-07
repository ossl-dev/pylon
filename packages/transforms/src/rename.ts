import type { RenameMap } from './types.js';

/**
 * Rename fields on an object.
 * Returns new object, does not mutate original.
 *
 * @example
 * rename({ first_name: 'John' }, { first_name: 'firstName' })
 * // => { firstName: 'John' }
 *
 * Handles:
 * - Missing keys: silently skipped
 * - Nested keys via dot notation: rename({ 'a.b': 'c' } -> not supported directly, use flatten/nest
 * - Passes through unmodified keys not in map
 */
export function rename<T extends Record<string, any>, M extends RenameMap>(
  obj: T,
  mapping: M,
): Omit<T, keyof M> & { [K in M[keyof M]]: any };
export function rename(obj: Record<string, any>, mapping: RenameMap): Record<string, any>;
export function rename(obj: Record<string, any>, mapping: RenameMap): Record<string, any> {
  if (obj == null) return {};
  const result: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    if (key in mapping) {
      const newKey = mapping[key];
      // newKey is string|undefined due to noUncheckedIndexedAccess,
      // but `key in mapping` guarantees it exists at runtime.
      if (newKey !== undefined) {
        result[newKey] = obj[key];
      } else {
        result[key] = obj[key];
      }
    } else {
      result[key] = obj[key];
    }
  }
  return result;
}
