import { setOwnProperty } from './object.js';
/**
 * Flatten a nested object into parent.
 * Like nest in reverse.
 *
 * @example
 * flatten({ address: { street: '123 Main', city: 'SF' }, name: 'John' }, 'address')
 * // => { street: '123 Main', city: 'SF', name: 'John' }
 *
 * If the key doesn't exist or isn't an object, passes through unchanged.
 */
export function flatten<T extends Record<string, any>>(
  obj: T | null | undefined,
  key: string,
): Omit<T, string> & Record<string, any>;
export function flatten(
  obj: Record<string, any> | null | undefined,
  key: string,
): Record<string, any>;
export function flatten(
  obj: Record<string, any> | null | undefined,
  key: string,
): Record<string, any> {
  if (obj == null) return {};

  if (!Object.hasOwn(obj, key)) return { ...obj };
  const nested = obj[key];

  if (nested == null || typeof nested !== 'object' || Array.isArray(nested)) {
    return { ...obj };
  }

  const result: Record<string, any> = {};

  for (const k of Object.keys(obj)) {
    if (k !== key) {
      setOwnProperty(result, k, obj[k]);
    }
  }

  for (const k of Object.keys(nested)) {
    setOwnProperty(result, k, nested[k]);
  }

  return result;
}
