import { describe, expect, it } from 'vitest';
import { defaults } from './defaults.js';

describe('defaults', () => {
  it('deep merges defaults into an object', () => {
    const result = defaults({ name: 'John' }, { email: 'unknown@example.com', age: 25 });
    expect(result).toEqual({ name: 'John', email: 'unknown@example.com', age: 25 });
  });

  it('does not override existing values', () => {
    const result = defaults(
      { name: 'John', email: 'john@test.com' },
      { email: 'default@test.com' },
    );
    expect(result).toEqual({ name: 'John', email: 'john@test.com' });
  });

  it('fills undefined fields', () => {
    const result = defaults({ name: 'John', email: undefined }, { email: 'default@test.com' });
    expect(result).toEqual({ name: 'John', email: 'default@test.com' });
  });

  it('fills null fields with deepFill option', () => {
    const result = defaults(
      { name: 'John', email: null },
      { email: 'default@test.com' },
      { deepFill: true },
    );
    expect(result).toEqual({ name: 'John', email: 'default@test.com' });
  });

  it('does not fill null fields without deepFill option', () => {
    const result = defaults({ name: 'John', email: null }, { email: 'default@test.com' });
    expect(result).toEqual({ name: 'John', email: null });
  });

  it('nested object merging', () => {
    const result = defaults({ address: { street: '123 Main' } }, { address: { country: 'US' } });
    expect(result).toEqual({ address: { street: '123 Main', country: 'US' } });
  });

  it('replaces arrays entirely (does not merge)', () => {
    const result = defaults({ tags: ['a', 'b'] }, { tags: ['x', 'y', 'z'] });
    expect(result).toEqual({ tags: ['a', 'b'] });
  });

  it('returns deep clone of defaults when first arg is null', () => {
    const defs = { name: 'John', address: { city: 'SF' } };
    const result = defaults(null, defs);
    expect(result).toEqual(defs);
    expect(result).not.toBe(defs);
    expect((result as any).address).not.toBe(defs.address);
  });

  it('returns deep clone of defaults when first arg is undefined', () => {
    const defs = { name: 'John', address: { city: 'SF' } };
    const result = defaults(undefined, defs);
    expect(result).toEqual(defs);
    expect(result).not.toBe(defs);
    expect((result as any).address).not.toBe(defs.address);
  });

  it('respects max depth option', () => {
    const result = defaults({ a: { b: { c: 1 } } }, { a: { b: { d: 2 } } }, { maxDepth: 2 });
    expect(result).toEqual({ a: { b: { c: 1 } } });
  });

  it('returns spread of obj when defaults is null', () => {
    const obj = { name: 'John' };
    const result = defaults(obj, null as any);
    expect(result).toEqual({ name: 'John' });
    expect(result).not.toBe(obj);
  });

  it('deep clones array values from defaults on null input', () => {
    const defs = { items: [{ id: 1 }, { id: 2 }] };
    const result = defaults(null, defs);
    expect(result).toEqual(defs);
    expect(result).not.toBe(defs);
    expect((result as any).items).not.toBe(defs.items);
    expect((result as any).items[0]).not.toBe(defs.items[0]);
  });

  it('handles deeply nested merging', () => {
    const result = defaults(
      { profile: { name: 'John', address: { city: 'SF' } } },
      { profile: { age: 30, address: { country: 'US' } } },
    );
    expect(result).toEqual({
      profile: { name: 'John', age: 30, address: { city: 'SF', country: 'US' } },
    });
  });

  it('does not append array elements from defaults', () => {
    const result = defaults({ items: [1, 2, 3] }, { items: [4, 5] });
    expect(result).toEqual({ items: [1, 2, 3] });
  });
});
