import { setOwnProperty } from './object.js';
/**
 * Nest flat fields into a nested object.
 *
 * @example
 * nest({ street: '123 Main', city: 'SF', country: 'US' }, ['street', 'city', 'country'], 'address')
 * // => { address: { street: '123 Main', city: 'SF', country: 'US' } }
 *
 * Only includes keys that actually exist on the source object.
 */
export function nest<T extends Record<string, any>, K extends keyof T>(
  obj: T | null | undefined,
  keys: K[],
  newKey: string,
): Omit<T, K> & Record<string, Pick<T, K>>;
export function nest(
  obj: Record<string, any> | null | undefined,
  keys: string[],
  newKey: string,
): Record<string, any>;
export function nest(
  obj: Record<string, any> | null | undefined,
  keys: string[],
  newKey: string,
): Record<string, any> {
  if (obj == null) return {};

  const nested: Record<string, any> = {};
  const result: Record<string, any> = {};
  let hasNestedKeys = false;

  for (const key of Object.keys(obj)) {
    if (keys.includes(key)) {
      setOwnProperty(nested, key, obj[key]);
      hasNestedKeys = true;
    } else {
      setOwnProperty(result, key, obj[key]);
    }
  }

  if (hasNestedKeys) {
    setOwnProperty(result, newKey, nested);
  }

  return result;
}
