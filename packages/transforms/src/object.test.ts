import { describe, expect, it, vi } from 'vitest';
import { coerce, combine, defaults, drop, flatten, map, nest, pick, rename } from './index.js';

const input = () =>
  JSON.parse('{"__proto__":{"admin":true},"constructor":"data","name":"Ada"}') as Record<
    string,
    unknown
  >;

describe('ordinary JSON property semantics', () => {
  it.each([
    ['rename', () => rename(input(), {})],
    ['pick', () => pick(input(), ['__proto__', 'name'])],
    ['drop', () => drop(input(), ['constructor'])],
    ['nest', () => nest(input(), ['name'], 'profile')],
    ['flatten', () => flatten({ profile: input() }, 'profile')],
    ['defaults', () => defaults({}, input())],
    ['clone defaults', () => defaults(null, input())],
  ] as const)('%s keeps prototype-looking keys as own data', (_name, transform) => {
    const result = transform();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result).not.toHaveProperty('admin');
    expect(JSON.parse(JSON.stringify(result)).__proto__).toEqual({ admin: true });
  });

  it('supports prototype-looking target names without changing prototypes', () => {
    expect(Object.getPrototypeOf(rename({ name: { admin: true } }, { name: '__proto__' }))).toBe(
      Object.prototype,
    );
    expect(Object.getPrototypeOf(nest({ name: 'Ada' }, ['name'], '__proto__'))).toBe(
      Object.prototype,
    );
  });

  it('does not apply inherited rename mappings or map inherited values', () => {
    expect(rename({ constructor: 'data' }, {})).toEqual({ constructor: 'data' });
    const fn = vi.fn(() => 'modified');
    expect(map({}, 'constructor', fn)).toEqual({});
    expect(coerce({}, 'constructor', fn)).toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });

  it('preserves spaced and Unicode string values when combining fields', () => {
    expect(combine('Ada', null, 'Lovelace Byron')).toBe('Ada Lovelace Byron');
    expect(combine('A', 'B', '李')).toBe('A B 李');
    expect(combine('A', 'B', "O'Connor")).toBe("A B O'Connor");
    expect(combine('A', 'B', ', ')).toBe('A, B');
  });

  it('clones Date defaults and cyclic defaults without losing values or recursing forever', () => {
    const date = new Date('2024-02-29T00:00:00Z');
    const source: { date: Date; self?: unknown } = { date };
    source.self = source;
    const result = defaults(null, source);
    expect(result.date).toEqual(date);
    expect(result.date).not.toBe(date);
    expect(result.self).toBe(result);
  });
});

it('terminates when both inputs to defaults contain cycles', () => {
  const source: Record<string, unknown> = { name: 'Ada' };
  const fallback: Record<string, unknown> = { email: 'ada@example.com' };
  source.self = source;
  fallback.self = fallback;
  const result = defaults(source, fallback);
  expect(result).toHaveProperty('name', 'Ada');
  expect(result).toHaveProperty('email', 'ada@example.com');
  expect(result.self).toBe(result);
});
