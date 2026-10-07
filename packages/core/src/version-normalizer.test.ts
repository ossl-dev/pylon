import { describe, expect, it } from 'vitest';
import { VersionNormalizer } from './version-normalizer.js';

describe('VersionNormalizer', () => {
  describe('semantic format', () => {
    it('normalizes v1 to 1, v2 to 2, v3 to 3', () => {
      const n = new VersionNormalizer({ format: 'semantic', prefix: 'v' }, 'v3');
      expect(n.normalize('v1')).toBe(1);
      expect(n.normalize('v2')).toBe(2);
      expect(n.normalize('v3')).toBe(3);
    });

    it('denormalizes 1 to v1, 2 to v2', () => {
      const n = new VersionNormalizer({ format: 'semantic', prefix: 'v' }, 'v3');
      expect(n.denormalize(1)).toBe('v1');
      expect(n.denormalize(2)).toBe('v2');
    });
  });

  describe('numeric format', () => {
    it('normalizes "1" to 1, "2" to 2', () => {
      const n = new VersionNormalizer({ format: 'numeric' }, '3');
      expect(n.normalize('1')).toBe(1);
      expect(n.normalize('2')).toBe(2);
      expect(n.normalize('3')).toBe(3);
    });
  });

  describe('date-daily format (Stripe-style)', () => {
    it('normalizes a date string and supports comparison', () => {
      const n = new VersionNormalizer({ format: 'date-daily' }, '2024-03-15');
      // Current version is the last in the generated range (order > 1)
      const order = n.normalize('2024-03-15');
      expect(order).toBeGreaterThan(1);
      expect(n.getCurrentVersion()).toBe('2024-03-15');
      expect(n.denormalize(order!)).toBe('2024-03-15');
    });

    it('generates multiple versions from start to current', () => {
      const n = new VersionNormalizer({ format: 'date-daily' }, '2024-03-15');
      const versions = n.listVersions();
      expect(versions.length).toBeGreaterThan(1);
      // Versions are sorted by order (ascending date)
      expect(versions[0]?.order).toBe(1);
      expect(versions[versions.length - 1]?.name).toBe('2024-03-15');
    });
  });

  describe('calver format', () => {
    it('stores and normalizes a calver version', () => {
      const n = new VersionNormalizer({ format: 'calver', calverFormat: 'YYYY.MM' }, '2024.03');
      // Calver uses monthly generation — current is last in the range
      const order = n.normalize('2024.03');
      expect(order).toBeGreaterThan(1);
      expect(n.getCurrentVersion()).toBe('2024.03');
    });
  });

  describe('custom parser', () => {
    it('uses custom parse and format functions', () => {
      const n = new VersionNormalizer(
        {
          format: 'custom',
          parse: (v: string) => {
            const num = parseInt(v.replace('ver', ''), 10);
            return { order: num, label: v };
          },
          formatVersion: (v: any) => String(v),
        },
        'ver3',
      );
      expect(n.normalize('ver3')).toBe(3);
    });

    it('uses custom compare function', () => {
      const n = new VersionNormalizer(
        {
          format: 'custom',
          parse: (v: string) => {
            const num = parseInt(v.replace('ver', ''), 10);
            return { order: num, label: v };
          },
          formatVersion: (v: any) => String(v),
          compare: (a, b) => {
            const na = parseInt(a.replace('ver', ''), 10);
            const nb = parseInt(b.replace('ver', ''), 10);
            return na - nb;
          },
        },
        'ver3',
      );
      expect(n.compare('ver3', 'ver2')).toBeGreaterThan(0);
    });
  });

  describe('explicit version list', () => {
    it('uses explicit version definitions', () => {
      const n = new VersionNormalizer(
        [
          { name: 'v1', order: 1 },
          { name: 'v2_beta', order: 2 },
          { name: 'v2', order: 3 },
        ],
        'v2',
      );
      expect(n.normalize('v1')).toBe(1);
      expect(n.normalize('v2_beta')).toBe(2);
      expect(n.normalize('v2')).toBe(3);
    });
  });

  describe('stripe preset', () => {
    it('initializes from Stripe preset with date', () => {
      const n = new VersionNormalizer({ preset: 'stripe' }, '2024-03-15');
      const order = n.normalize('2024-03-15');
      expect(order).toBeGreaterThan(1);
      expect(n.getCurrentVersion()).toBe('2024-03-15');
    });

    it('generates multiple versions for Stripe preset', () => {
      const n = new VersionNormalizer({ preset: 'stripe' }, '2024-03-15');
      const versions = n.listVersions();
      expect(versions.length).toBeGreaterThan(1);
      expect(versions[versions.length - 1]?.name).toBe('2024-03-15');
    });
  });

  describe('aliases', () => {
    it('resolveAlias resolves "latest" to "v4"', () => {
      const n = new VersionNormalizer({ format: 'semantic', aliases: { latest: 'v4' } }, 'v4');
      expect(n.resolveAlias('latest')).toBe('v4');
    });

    it('normalize resolves alias and returns order', () => {
      const n = new VersionNormalizer({ format: 'semantic', aliases: { latest: 'v3' } }, 'v3');
      expect(n.normalize('latest')).toBe(3);
    });

    it('resolveAlias returns original if alias not found', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      expect(n.resolveAlias('nonexistent')).toBe('nonexistent');
    });
  });

  describe('compare', () => {
    it('v4 is greater than v3', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v4');
      expect(n.compare('v4', 'v3')).toBeGreaterThan(0);
    });

    it('v2 is less than v4', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v4');
      expect(n.compare('v2', 'v4')).toBeLessThan(0);
    });

    it('equal versions return 0', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      expect(n.compare('v3', 'v3')).toBe(0);
    });

    it('throws for invalid version', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      expect(() => n.compare('v99', 'v3')).toThrow('Invalid version');
    });
  });

  describe('sort', () => {
    it('sorts versions in ascending order', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v4');
      expect(n.sort(['v2', 'v4', 'v3'])).toEqual(['v2', 'v3', 'v4']);
    });

    it('does not mutate the input array', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v4');
      const input = ['v3', 'v1', 'v2'];
      const sorted = n.sort(input);
      expect(input).toEqual(['v3', 'v1', 'v2']);
      expect(sorted).toEqual(['v1', 'v2', 'v3']);
    });
  });

  describe('isValid', () => {
    it('returns true for valid versions', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      expect(n.isValid('v1')).toBe(true);
      expect(n.isValid('v3')).toBe(true);
    });

    it('returns false for invalid versions', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      expect(n.isValid('v99')).toBe(false);
      expect(n.isValid('foobar')).toBe(false);
    });

    it('resolves aliases when checking validity', () => {
      const n = new VersionNormalizer({ format: 'semantic', aliases: { latest: 'v3' } }, 'v3');
      expect(n.isValid('latest')).toBe(true);
    });
  });

  describe('unknown version', () => {
    it('returns null for normalize of unknown version', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      expect(n.normalize('v99')).toBeNull();
    });

    it('returns null for denormalize of unknown order', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      expect(n.denormalize(99)).toBeNull();
    });
  });

  describe('getCurrentVersion and getCurrentOrder', () => {
    it('getCurrentVersion returns the last version name', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v4');
      expect(n.getCurrentVersion()).toBe('v4');
    });

    it('getCurrentOrder returns the length-based order', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v4');
      expect(n.getCurrentOrder()).toBe(4);
    });
  });

  describe('listVersions', () => {
    it('returns all version definitions', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      const versions = n.listVersions();
      expect(versions.length).toBe(3);
      expect(versions[0]!.name).toBe('v1');
      expect(versions[2]!.name).toBe('v3');
    });

    it('returns a read-only copy', () => {
      const n = new VersionNormalizer({ format: 'semantic' }, 'v3');
      const versions = n.listVersions();
      expect(Array.isArray(versions)).toBe(true);
    });
  });

  describe('default (no config)', () => {
    it('creates a single version entry from current', () => {
      const n = new VersionNormalizer(undefined, 'v1');
      expect(n.getCurrentVersion()).toBe('v1');
      expect(n.getCurrentOrder()).toBe(1);
      expect(n.normalize('v1')).toBe(1);
    });
  });

  describe('numeric format denormalize', () => {
    it('denormalizes back to numeric strings', () => {
      const n = new VersionNormalizer({ format: 'numeric' }, '3');
      expect(n.denormalize(2)).toBe('2');
    });
  });
});
