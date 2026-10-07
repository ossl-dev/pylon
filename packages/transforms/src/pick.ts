import { setOwnProperty } from './object.js';
/**
 * Keep only specified keys from an object.
 * Returns new object with only those keys.
 *
 * @example
 * pick({ name: 'John', email: 'john@test.com', age: 30 }, ['name', 'email'])
 * // => { name: 'John', email: 'john@test.com' }
 *
 * Handles: non-existent keys (silently skipped), null/undefined input (returns {})
 */
export function pick<T extends Record<string, any>, K extends keyof T>(
  obj: T | null | undefined,
  keys: K[],
): Pick<T, K>;
export function pick(
  obj: Record<string, any> | null | undefined,
  keys: string[],
): Record<string, any>;
export function pick(
  obj: Record<string, any> | null | undefined,
  keys: string[],
): Record<string, any> {
  if (obj == null) return {};
  const result: Record<string, any> = {};
  for (const key of keys) {
    if (Object.hasOwn(obj, key)) {
      setOwnProperty(result, key, obj[key]);
    }
  }
  return result;
}
