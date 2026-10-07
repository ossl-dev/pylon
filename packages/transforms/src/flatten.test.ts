import { describe, expect, it } from 'vitest';
import { flatten } from './flatten.js';

describe('flatten', () => {
  it('flattens a nested object into parent', () => {
    const result = flatten(
      { address: { street: '123 Main', city: 'SF' }, name: 'John' },
      'address',
    );
    expect(result).toEqual({ street: '123 Main', city: 'SF', name: 'John' });
  });

  it('passes through unchanged when the key does not exist', () => {
    const input = { name: 'John' };
    const result = flatten(input, 'address');
    expect(result).toEqual({ name: 'John' });
  });

  it('passes through unchanged when the key is not an object', () => {
    const input = { name: 'John' };
    const result = flatten(input, 'name');
    expect(result).toEqual({ name: 'John' });
  });

  it('passes through unchanged when the key is null', () => {
    const input = { address: null, name: 'John' };
    const result = flatten(input as any, 'address');
    expect(result).toEqual({ address: null, name: 'John' });
  });

  it('passes through unchanged when the key is an array', () => {
    const input = { tags: ['a', 'b'], name: 'John' };
    const result = flatten(input, 'tags');
    expect(result).toEqual({ tags: ['a', 'b'], name: 'John' });
  });

  it('returns empty object for null input', () => {
    expect(flatten(null as any, 'address')).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(flatten(undefined as any, 'address')).toEqual({});
  });

  it('does not mutate the original', () => {
    const original = { address: { street: '123 Main' }, name: 'John' };
    const result = flatten(original, 'address');
    expect(original).toEqual({ address: { street: '123 Main' }, name: 'John' });
    expect(result).not.toBe(original);
  });
});
