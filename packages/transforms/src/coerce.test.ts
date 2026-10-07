import { describe, expect, it } from 'vitest';
import { coerce } from './coerce.js';

describe('coerce', () => {
  it('transforms a field via function', () => {
    const result = coerce({ age: '30' }, 'age', (val: string) => parseInt(val, 10));
    expect(result).toEqual({ age: 30 });
  });

  it('missing key passes through unchanged', () => {
    const result = coerce({ name: 'John' }, 'missing', (_val: any) => 'never called');
    expect(result).toEqual({ name: 'John' });
  });

  it('returns empty object for null input', () => {
    const result = coerce(null as any, 'age', (v: any) => v);
    expect(result).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    const result = coerce(undefined as any, 'age', (v: any) => v);
    expect(result).toEqual({});
  });

  describe('coerce.toString', () => {
    it('converts number to string', () => {
      expect(coerce.toString(42)).toBe('42');
    });

    it('converts boolean to string', () => {
      expect(coerce.toString(true)).toBe('true');
    });

    it('converts null to empty string', () => {
      expect(coerce.toString(null)).toBe('');
    });

    it('converts undefined to empty string', () => {
      expect(coerce.toString(undefined)).toBe('');
    });

    it('converts object to string', () => {
      expect(coerce.toString({ a: 1 })).toBe('[object Object]');
    });
  });

  describe('coerce.toNumber', () => {
    it('converts string to number', () => {
      expect(coerce.toNumber('42')).toBe(42);
    });

    it('converts null to 0', () => {
      expect(coerce.toNumber(null)).toBe(0);
    });

    it('converts undefined to 0', () => {
      expect(coerce.toNumber(undefined)).toBe(0);
    });

    it('converts NaN result to 0', () => {
      expect(coerce.toNumber('not-a-number')).toBe(0);
    });

    it('converts boolean true to 1', () => {
      expect(coerce.toNumber(true)).toBe(1);
    });

    it('converts boolean false to 0', () => {
      expect(coerce.toNumber(false)).toBe(0);
    });
  });

  describe('coerce.toBoolean', () => {
    it('returns boolean as-is', () => {
      expect(coerce.toBoolean(true)).toBe(true);
      expect(coerce.toBoolean(false)).toBe(false);
    });

    it('converts null to false', () => {
      expect(coerce.toBoolean(null)).toBe(false);
    });

    it('converts undefined to false', () => {
      expect(coerce.toBoolean(undefined)).toBe(false);
    });

    it('converts string "true" to true', () => {
      expect(coerce.toBoolean('true')).toBe(true);
    });

    it('converts string "1" to true', () => {
      expect(coerce.toBoolean('1')).toBe(true);
    });

    it('converts string "yes" to true (case-insensitive)', () => {
      expect(coerce.toBoolean('YES')).toBe(true);
    });

    it('converts other strings to false', () => {
      expect(coerce.toBoolean('false')).toBe(false);
    });

    it('converts non-zero numbers to true', () => {
      expect(coerce.toBoolean(42)).toBe(true);
    });

    it('converts 0 to false', () => {
      expect(coerce.toBoolean(0)).toBe(false);
    });
  });

  describe('coerce.toDate', () => {
    it('returns Date instance as-is', () => {
      const d = new Date('2024-01-15');
      expect(coerce.toDate(d)).toBe(d);
    });

    it('converts date string to Date', () => {
      const result = coerce.toDate('2024-01-15');
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(new Date('2024-01-15').getTime());
    });

    it('converts null to invalid Date', () => {
      const result = coerce.toDate(null);
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeNaN();
    });

    it('converts undefined to invalid Date', () => {
      const result = coerce.toDate(undefined);
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeNaN();
    });

    it('converts invalid string to invalid Date', () => {
      const result = coerce.toDate('not-a-date');
      expect(result).toBeInstanceOf(Date);
      expect(Number.isNaN(result.getTime())).toBe(true);
    });
  });

  describe('coerce.toArray', () => {
    it('returns array as-is', () => {
      const arr = [1, 2, 3];
      expect(coerce.toArray(arr)).toBe(arr);
    });

    it('wraps single value in array', () => {
      expect(coerce.toArray(42)).toEqual([42]);
    });

    it('converts null to empty array', () => {
      expect(coerce.toArray(null)).toEqual([]);
    });

    it('converts undefined to empty array', () => {
      expect(coerce.toArray(undefined)).toEqual([]);
    });

    it('wraps string in array', () => {
      expect(coerce.toArray('hello')).toEqual(['hello']);
    });
  });
});
