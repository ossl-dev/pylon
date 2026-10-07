import { describe, expect, it } from 'vitest';
import { split } from './split.js';

describe('split', () => {
  it('splits "John Doe" at index 0 to get "John"', () => {
    expect(split('John Doe', 0)).toBe('John');
  });

  it('splits "John Doe" at index 1 to get "Doe"', () => {
    expect(split('John Doe', 1)).toBe('Doe');
  });

  it('returns original value when separator is not found', () => {
    expect(split('John', 0)).toBe('John');
  });

  it('returns empty string for null input', () => {
    expect(split(null, 0)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(split(undefined, 0)).toBe('');
  });

  it('uses custom separator', () => {
    expect(split('a,b,c', 1, ',')).toBe('b');
  });

  it('returns empty string for index beyond parts length', () => {
    expect(split('a b', 5)).toBe('');
  });

  it('handles empty string input', () => {
    expect(split('', 0)).toBe('');
  });

  it('handles multiple spaces', () => {
    // 'a  b  c'.split(' ') = ['a', '', 'b', '', 'c']
    expect(split('a  b  c', 2)).toBe('b');
  });
});
