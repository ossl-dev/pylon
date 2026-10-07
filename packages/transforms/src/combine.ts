/**
 * Combine multiple values into a single string with separator.
 * Filters out null/undefined/empty values.
 *
 * @example
 * combine('John', 'Doe')          // => 'John Doe'
 * combine('John', 'Doe', ', ')    // => 'John, Doe'
 * combine('John', null, 'Doe')    // => 'John Doe'
 * combine('', null)               // => ''
 * combine()                        // => ''
 */
export function combine(...values: (string | null | undefined)[]): string;
export function combine(...args: (string | null | undefined)[]): string {
  if (args.length === 0) return '';

  let delimiter = ' ';
  let values = args;

  // When 3+ args, a last argument containing only punctuation or whitespace
  // (e.g. ', ') is treated as the delimiter for convenience.
  if (args.length >= 3) {
    const lastArg = args[args.length - 1];
    if (lastArg != null && lastArg !== '' && /^[^\p{L}\p{N}]+$/u.test(lastArg)) {
      delimiter = lastArg;
      values = args.slice(0, -1);
    }
  }

  const filtered = values.filter((v) => v != null && v !== '');
  if (filtered.length === 0) return '';
  return filtered.join(delimiter);
}
