import { describe, expect, it } from 'vitest';
import { combine } from './combine.js';

describe('combine', () => {
  it('combines "John" and "Doe" into "John Doe" with default separator', () => {
    expect(combine('John', 'Doe')).toBe('John Doe');
  });

  it('filters null values', () => {
    expect(combine('John', null, 'Doe')).toBe('John Doe');
  });

  it('filters undefined values', () => {
    expect(combine('John', undefined, 'Doe')).toBe('John Doe');
  });

  it('filters empty string values', () => {
    expect(combine('John', '', 'Doe')).toBe('John Doe');
  });

  it('uses custom delimiter via first arg when 3+ args and last arg looks like delimiter', () => {
    const result = combine('John', 'Doe', ', ');
    expect(result).toBe('John, Doe');
  });

  it('returns empty string when no args provided', () => {
    expect(combine()).toBe('');
  });

  it('returns empty string when all values are null/undefined/empty', () => {
    expect(combine(null, undefined, '')).toBe('');
  });

  it('handles single value', () => {
    expect(combine('John')).toBe('John');
  });

  it('handles mixed null and empty strings', () => {
    expect(combine('A', null, '', 'B')).toBe('A B');
  });
});
