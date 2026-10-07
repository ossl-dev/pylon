/**
 * Type coercion utility. Transforms a field from one type to another.
 *
 * @example
 * coerce({ age: '30' }, 'age', (val: string) => parseInt(val, 10))
 * // => { age: 30 }
 *
 * Built-in coercion functions are available:
 * coerce.toString(val)
 * coerce.toNumber(val)
 * coerce.toBoolean(val)
 * coerce.toDate(val)
 * coerce.toArray(val)
 */
export function coerce<T extends Record<string, any>, K extends keyof T, R>(
  obj: T | null | undefined,
  key: K,
  fn: (value: T[K]) => R,
): Omit<T, K> & Record<K, R>;
export function coerce(
  obj: Record<string, any> | null | undefined,
  key: string,
  fn: (value: any) => any,
): Record<string, any>;
// Implementation — the namespace below adds static members via declaration merging
export function coerce(
  obj: Record<string, any> | null | undefined,
  key: string,
  fn: (value: any) => any,
): Record<string, any> {
  if (obj == null) return {};
  if (!(key in obj)) return { ...obj };
  return { ...obj, [key]: fn(obj[key]) };
}

export namespace coerce {
  /**
   * Coerce a value to string.
   * null/undefined become empty string.
   */
  // biome-ignore lint/suspicious/noShadowRestrictedNames: public coercion API
  export function toString(val: unknown): string {
    if (val == null) return '';
    return String(val);
  }

  /**
   * Coerce a value to number.
   * null/undefined become 0. NaN results become 0.
   */
  export function toNumber(val: unknown): number {
    if (val == null) return 0;
    const n = Number(val);
    return Number.isNaN(n) ? 0 : n;
  }

  /**
   * Coerce a value to boolean.
   * String 'true'/'1'/'yes' (case-insensitive) -> true.
   * Non-zero numbers -> true. null/undefined -> false.
   */
  export function toBoolean(val: unknown): boolean {
    if (typeof val === 'boolean') return val;
    if (val == null) return false;
    if (typeof val === 'string') {
      return ['true', '1', 'yes'].includes(val.toLowerCase());
    }
    if (typeof val === 'number') {
      return val !== 0;
    }
    return Boolean(val);
  }

  /**
   * Coerce a value to Date.
   * Already a Date is returned as-is. null/undefined returns invalid Date.
   */
  export function toDate(val: unknown): Date {
    if (val instanceof Date) return val;
    if (val == null) return new Date(Number.NaN);
    const d = new Date(val as any);
    return Number.isNaN(d.getTime()) ? new Date(Number.NaN) : d;
  }

  /**
   * Coerce a value to an array.
   * Wraps single values in an array. null/undefined becomes [].
   */
  export function toArray<T>(val: T | T[]): T[] {
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    return [val];
  }
}
