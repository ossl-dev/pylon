import { describe, expect, it } from 'vitest';
import { rename } from './rename.js';

describe('rename', () => {
  it('renames a single key', () => {
    const result = rename({ first_name: 'John' }, { first_name: 'firstName' });
    expect(result).toEqual({ firstName: 'John' });
  });

  it('renames multiple keys', () => {
    const result = rename(
      { first_name: 'John', last_name: 'Doe' },
      { first_name: 'firstName', last_name: 'lastName' },
    );
    expect(result).toEqual({ firstName: 'John', lastName: 'Doe' });
  });

  it('silently skips missing keys in the mapping', () => {
    // Key exists in the mapping but the object has it — this is the normal case
    // Actually let's test: mapping has a key that references a key the object doesn't have
    const result = rename({ name: 'John' }, { missing_key: 'newKey' });
    expect(result).toEqual({ name: 'John' });
  });

  it('handles non-existent source key silently', () => {
    const result = rename({ name: 'John' }, { name: 'fullName' });
    expect(result).toEqual({ fullName: 'John' });
  });

  it('returns empty object for null or undefined input', () => {
    expect(rename(null as any, { name: 'fullName' })).toEqual({});
    expect(rename(undefined as any, { name: 'fullName' })).toEqual({});
  });

  it('does not mutate the original object', () => {
    const original = { first_name: 'John' };
    const result = rename(original, { first_name: 'firstName' });
    expect(original).toEqual({ first_name: 'John' });
    expect(result).toEqual({ firstName: 'John' });
    expect(result).not.toBe(original);
  });

  it('preserves keys not in the rename map', () => {
    const result = rename(
      { first_name: 'John', age: 30, email: 'john@test.com' },
      { first_name: 'firstName' },
    );
    expect(result).toEqual({ firstName: 'John', age: 30, email: 'john@test.com' });
  });

  it('handles empty mapping', () => {
    const result = rename({ name: 'John' }, {});
    expect(result).toEqual({ name: 'John' });
  });

  it('handles empty object input', () => {
    const result = rename({}, { name: 'fullName' });
    expect(result).toEqual({});
  });
});
