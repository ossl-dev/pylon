import { describe, expect, it } from 'vitest';
import { compose } from './compose.js';

describe('compose', () => {
  it('composes functions left to right', () => {
    const addName = (r: Record<string, any>) => ({ ...r, name: r.firstName });
    const addEmail = (r: Record<string, any>) => ({ ...r, email: r.name + '@test.com' });
    const transform = compose(addName, addEmail);
    expect(transform({ firstName: 'John' })).toEqual({
      firstName: 'John',
      name: 'John',
      email: 'John@test.com',
    });
  });

  it('single function returns same result', () => {
    const transform = compose((r: number) => r * 2);
    expect(transform(5)).toBe(10);
  });

  it('supports async functions', async () => {
    const asyncAdd = async (r: Record<string, any>): Promise<Record<string, any>> => ({
      ...r,
      name: (r as Record<string, any>).firstName as string,
    });
    const transform = compose(asyncAdd);
    const result = await transform({ firstName: 'John' });
    expect(result).toEqual({ firstName: 'John', name: 'John' });
  });

  it('empty compose returns identity function', () => {
    const transform = compose();
    expect(transform(42)).toBe(42);
  });

  it('chains async and sync functions', async () => {
    const syncAdd = (r: Record<string, any>) => ({ ...r, name: r.firstName });
    const asyncAddEmail = async (r: Record<string, any>) => ({
      ...r,
      email: r.name + '@test.com',
    });
    const transform = compose(syncAdd, asyncAddEmail);
    const result = await transform({ firstName: 'John' });
    expect(result).toEqual({
      firstName: 'John',
      name: 'John',
      email: 'John@test.com',
    });
  });

  it('composes multiple async functions', async () => {
    const double = async (n: number) => n * 2;
    const addOne = async (n: number) => n + 1;
    const triple = async (n: number) => n * 3;
    const transform = compose(double, addOne, triple);
    // double(5) = 10, addOne(10) = 11, triple(11) = 33
    expect(await transform(5)).toBe(33);
  });

  it('applies transformations in correct order', () => {
    const addA = (r: string[]) => [...r, 'A'];
    const addB = (r: string[]) => [...r, 'B'];
    const transform = compose(addA, addB);
    expect(transform([])).toEqual(['A', 'B']);
  });
});
