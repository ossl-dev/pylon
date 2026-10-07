import { describe, expect, it } from 'vitest';
import { map } from './map.js';

describe('map', () => {
  it('transforms a field using a function', () => {
    const result = map({ age: '30' }, 'age', (val: string) => parseInt(val, 10));
    expect(result).toEqual({ age: 30 });
  });

  it('transforms string to uppercase', () => {
    const result = map({ name: 'john' }, 'name', (val: string) => val.toUpperCase());
    expect(result).toEqual({ name: 'JOHN' });
  });

  it('missing key passes through unchanged', () => {
    const result = map({ name: 'john' }, 'missing', (_val: any) => 'never called');
    expect(result).toEqual({ name: 'john' });
  });

  it('returns empty object for null input', () => {
    expect(map(null as any, 'name', (v: any) => v)).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(map(undefined as any, 'name', (v: any) => v)).toEqual({});
  });

  it('preserves other keys when transforming', () => {
    const result = map({ name: 'john', age: '30', email: 'john@test.com' }, 'age', (val: string) =>
      parseInt(val, 10),
    );
    expect(result).toEqual({ name: 'john', age: 30, email: 'john@test.com' });
  });

  it('does not mutate the original', () => {
    const original = { age: '30' };
    const result = map(original, 'age', (val: string) => parseInt(val, 10));
    expect(original).toEqual({ age: '30' });
    expect(result).not.toBe(original);
  });
});
