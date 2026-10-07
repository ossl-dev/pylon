import { describe, expect, it } from 'vitest';
import { pick } from './pick.js';

describe('pick', () => {
  it('keeps only specified keys', () => {
    const result = pick({ name: 'John', email: 'john@test.com', age: 30 }, ['name', 'email']);
    expect(result).toEqual({ name: 'John', email: 'john@test.com' });
  });

  it('silently skips non-existent keys', () => {
    const result = pick({ name: 'John' }, ['name', 'nonexistent']);
    expect(result).toEqual({ name: 'John' });
  });

  it('returns empty object for null input', () => {
    expect(pick(null as any, ['name'])).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(pick(undefined as any, ['name'])).toEqual({});
  });

  it('returns empty object when picking empty array', () => {
    const result = pick({ name: 'John', age: 30 }, []);
    expect(result).toEqual({});
  });

  it('picks a single key', () => {
    const result = pick({ name: 'John', age: 30 }, ['name']);
    expect(result).toEqual({ name: 'John' });
  });

  it('does not mutate the original', () => {
    const original = { name: 'John', age: 30 };
    const result = pick(original, ['name']);
    expect(original).toEqual({ name: 'John', age: 30 });
    expect(result).toEqual({ name: 'John' });
    expect(result).not.toBe(original);
  });
});
