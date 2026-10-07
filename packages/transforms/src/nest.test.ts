import { describe, expect, it } from 'vitest';
import { nest } from './nest.js';

describe('nest', () => {
  it('nests flat fields into a nested object', () => {
    const result = nest(
      { street: '123 Main', city: 'SF', country: 'US' },
      ['street', 'city', 'country'],
      'address',
    );
    expect(result).toEqual({
      address: { street: '123 Main', city: 'SF', country: 'US' },
    });
  });

  it('only includes existing keys in the nested object', () => {
    const result = nest(
      { street: '123 Main', country: 'US' },
      ['street', 'city', 'country'],
      'address',
    );
    expect(result).toEqual({
      address: { street: '123 Main', country: 'US' },
    });
  });

  it('returns empty object for null input', () => {
    expect(nest(null as any, ['street'], 'address')).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(nest(undefined as any, ['street'], 'address')).toEqual({});
  });

  it('preserves non-nested keys at the top level', () => {
    const result = nest(
      { street: '123 Main', city: 'SF', name: 'John', age: 30 },
      ['street', 'city'],
      'address',
    );
    expect(result).toEqual({
      address: { street: '123 Main', city: 'SF' },
      name: 'John',
      age: 30,
    });
  });

  it('does not create nested key when no keys are nested', () => {
    const result = nest({ name: 'John' }, ['street', 'city'], 'address');
    expect(result).toEqual({ name: 'John' });
  });

  it('does not mutate the original', () => {
    const original = { street: '123 Main', city: 'SF' };
    const result = nest(original, ['street'], 'address');
    expect(original).toEqual({ street: '123 Main', city: 'SF' });
    expect(result).not.toBe(original);
  });
});
