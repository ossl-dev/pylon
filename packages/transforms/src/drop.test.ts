import { describe, expect, it } from 'vitest';
import { drop } from './drop.js';

describe('drop', () => {
  it('removes specified keys', () => {
    const result = drop({ name: 'John', email: 'john@test.com', ssn: '123-45-6789' }, ['ssn']);
    expect(result).toEqual({ name: 'John', email: 'john@test.com' });
  });

  it('removes multiple keys', () => {
    const result = drop({ name: 'John', email: 'john@test.com', age: 30, ssn: '123-45-6789' }, [
      'ssn',
      'age',
    ]);
    expect(result).toEqual({ name: 'John', email: 'john@test.com' });
  });

  it('silently ignores non-existent keys', () => {
    const result = drop({ name: 'John' }, ['nonexistent']);
    expect(result).toEqual({ name: 'John' });
  });

  it('returns empty object for null input', () => {
    expect(drop(null as any, ['name'])).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(drop(undefined as any, ['name'])).toEqual({});
  });

  it('retains all keys when dropping empty array', () => {
    const result = drop({ name: 'John', age: 30 }, []);
    expect(result).toEqual({ name: 'John', age: 30 });
  });

  it('returns empty object when all keys are dropped', () => {
    const result = drop({ name: 'John' }, ['name']);
    expect(result).toEqual({});
  });

  it('does not mutate the original', () => {
    const original = { name: 'John', ssn: '123-45' };
    const result = drop(original, ['ssn']);
    expect(original).toEqual({ name: 'John', ssn: '123-45' });
    expect(result).toEqual({ name: 'John' });
    expect(result).not.toBe(original);
  });
});
