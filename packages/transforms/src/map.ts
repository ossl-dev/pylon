/**
 * Transform a single field using a mapping function.
 * If field doesn't exist, passes through unchanged.
 *
 * @example
 * map({ age: '30' }, 'age', (val) => parseInt(val, 10))
 * // => { age: 30 }
 *
 * map({ name: 'john' }, 'name', (val) => val.toUpperCase())
 * // => { name: 'JOHN' }
 *
 * map({ name: 'john' }, 'missing', (val) => 'never called')
 * // => { name: 'john' } (missing key passes through)
 */
export function map<T extends Record<string, any>, K extends keyof T, R>(
  obj: T | null | undefined,
  key: K,
  fn: (value: T[K]) => R,
): Omit<T, K> & Record<K, R>;
export function map(
  obj: Record<string, any> | null | undefined,
  key: string,
  fn: (value: any) => any,
): Record<string, any>;
export function map(
  obj: Record<string, any> | null | undefined,
  key: string,
  fn: (value: any) => any,
): Record<string, any> {
  if (obj == null) return {};
  if (!(key in obj)) return { ...obj };
  return { ...obj, [key]: fn(obj[key]) };
}
