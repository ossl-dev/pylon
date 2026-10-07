import { setOwnProperty } from './object.js';
/**
 * Remove specified keys from an object.
 * Returns new object without those keys.
 *
 * @example
 * drop({ name: 'John', email: 'john@test.com', ssn: '123-45-6789' }, ['ssn'])
 * // => { name: 'John', email: 'john@test.com' }
 *
 * Handles: non-existent keys (silently ignored), null/undefined input (returns {})
 */
export function drop<T extends Record<string, any>, K extends keyof T>(
  obj: T | null | undefined,
  keys: K[],
): Omit<T, K>;
export function drop(
  obj: Record<string, any> | null | undefined,
  keys: string[],
): Record<string, any>;
export function drop(
  obj: Record<string, any> | null | undefined,
  keys: string[],
): Record<string, any> {
  if (obj == null) return {};
  const result: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      setOwnProperty(result, key, obj[key]);
    }
  }
  return result;
}
