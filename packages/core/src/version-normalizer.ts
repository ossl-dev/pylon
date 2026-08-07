import type { VersionsConfig, VersionDefinition, VersionFormat } from './types.js';

/**
 * Normalizes version strings to internal order indices and back.
 *
 * Supports multiple version formats:
 * - **semantic**: `v1`, `v2`, `v3` (configurable prefix)
 * - **numeric**: `1`, `2`, `3`
 * - **date-monthly**: `2024-01`, `2024-02`
 * - **date-daily**: `2024-01-15`, `2024-01-16`
 * - **calver**: calendar versioning
 * - **custom**: user-provided parse/format functions
 * - **stripe preset**: date-daily with `YYYY-MM-DD` format
 */
export class VersionNormalizer {
  private versions: VersionDefinition[];
  private aliasMap: Map<string, string>;
  private versionMap: Map<string, number>;
  private reverseMap: Map<number, string>;
  private customCompare?: (a: string, b: string) => number;

  constructor(config: VersionsConfig | undefined, current: string) {
    this.versions = [];
    this.aliasMap = new Map();
    this.versionMap = new Map();
    this.reverseMap = new Map();

    if (!config) {
      // Default: treat current as the only version
      this.versions.push({ name: current, order: 1 });
      this.versionMap.set(current, 1);
      this.reverseMap.set(1, current);
      return;
    }

    if (Array.isArray(config)) {
      this.initFromList(config, current);
    } else if ('preset' in config && config.preset === 'stripe') {
      this.initStripe(current);
    } else if ('format' in config && config.format === 'custom') {
      this.initCustom(config as unknown as { parse: (v: string) => { order: number; label: string }; formatVersion: (v: any) => string; compare?: (a: string, b: string) => number }, current);
    } else if ('format' in config) {
      this.initFromFormat(config as { format: VersionFormat; prefix?: string; dateFormat?: string; calverFormat?: string; aliases?: Record<string, string> }, current);
    }
  }

  /**
   * Parse version config from a format-based configuration.
   * Generates versions from the current version back to 1.
   */
  private initFromFormat(
    formatCfg: { format: VersionFormat; prefix?: string; dateFormat?: string; calverFormat?: string; aliases?: Record<string, string> },
    current: string
  ): void {
    if (formatCfg.aliases) {
      for (const [alias, target] of Object.entries(formatCfg.aliases)) {
        this.aliasMap.set(alias, target);
      }
    }

    switch (formatCfg.format) {
      case 'semantic': {
        const prefix = formatCfg.prefix ?? 'v';
        // Parse current version number (e.g., "v5" -> 5)
        const currentNum = parseInt(current.replace(prefix, ''), 10);
        if (isNaN(currentNum)) {
          // Fall back to single version
          this.versions.push({ name: current, order: 1 });
          this.versionMap.set(current, 1);
          this.reverseMap.set(1, current);
          return;
        }
        for (let i = 1; i <= currentNum; i++) {
          const name = `${prefix}${i}`;
          this.versions.push({ name, order: i });
          this.versionMap.set(name, i);
          this.reverseMap.set(i, name);
        }
        break;
      }
      case 'numeric': {
        const currentNum = parseInt(current, 10);
        if (isNaN(currentNum)) {
          this.versions.push({ name: current, order: 1 });
          this.versionMap.set(current, 1);
          this.reverseMap.set(1, current);
          return;
        }
        for (let i = 1; i <= currentNum; i++) {
          const name = String(i);
          this.versions.push({ name, order: i });
          this.versionMap.set(name, i);
          this.reverseMap.set(i, name);
        }
        break;
      }
      case 'date-monthly': {
        const versions = generateDateVersions(current, 'monthly', formatCfg.dateFormat);
        versions.forEach((v, i) => {
          const order = i + 1;
          this.versions.push({ name: v, order });
          this.versionMap.set(v, order);
          this.reverseMap.set(order, v);
        });
        break;
      }
      case 'date-daily': {
        const versions = generateDateVersions(current, 'daily', formatCfg.dateFormat);
        versions.forEach((v, i) => {
          const order = i + 1;
          this.versions.push({ name: v, order });
          this.versionMap.set(v, order);
          this.reverseMap.set(order, v);
        });
        break;
      }
      case 'calver': {
        const versions = generateDateVersions(current, 'monthly', formatCfg.calverFormat);
        versions.forEach((v, i) => {
          const order = i + 1;
          this.versions.push({ name: v, order });
          this.versionMap.set(v, order);
          this.reverseMap.set(order, v);
        });
        break;
      }
      default:
        this.versions.push({ name: current, order: 1 });
        this.versionMap.set(current, 1);
        this.reverseMap.set(1, current);
        break;
    }
  }

  /**
   * Initialize from a list of explicit version definitions.
   */
  private initFromList(list: VersionDefinition[], _current: string): void {
    const sorted = [...list].sort((a, b) => a.order - b.order);
    let order = 1;
    for (const v of sorted) {
      const def: VersionDefinition = { ...v, order };
      this.versions.push(def);
      this.versionMap.set(def.name, order);
      this.reverseMap.set(order, def.name);
      order++;
    }
  }

  /**
   * Initialize with Stripe preset (date-daily with YYYY-MM-DD).
   */
  private initStripe(current: string): void {
    const versions = generateDateVersions(current, 'daily');
    versions.forEach((v, i) => {
      const order = i + 1;
      this.versions.push({ name: v, order });
      this.versionMap.set(v, order);
      this.reverseMap.set(order, v);
    });
  }

  /**
   * Initialize with custom parse/format functions.
   */
  private initCustom(
    cfg: { parse: (v: string) => { order: number; label: string }; formatVersion: (v: any) => string; compare?: (a: string, b: string) => number },
    current: string
  ): void {
    this.customCompare = cfg.compare;

    const parsed = cfg.parse(current);
    this.versions.push({ name: current, order: parsed.order });
    this.versionMap.set(current, parsed.order);
    this.reverseMap.set(parsed.order, current);
  }

  /**
   * Convert an external version name to its internal order index (1-based).
   * Returns `null` if the version is unknown.
   *
   * @param external - The version string to normalize (e.g., `"v2"`, `"2024-01-15"`)
   * @returns The 1-based order index, or `null` if unknown
   */
  normalize(external: string): number | null {
    // Check aliases first
    const resolved = this.resolveAlias(external);
    return this.versionMap.get(resolved) ?? null;
  }

  /**
   * Convert an internal order index back to the external version name.
   * Returns `null` if the index is unknown.
   *
   * @param internal - The 1-based order index
   * @returns The external version string, or `null` if unknown
   */
  denormalize(internal: number): string | null {
    return this.reverseMap.get(internal) ?? null;
  }

  /**
   * Compare two version strings.
   * Returns a negative number if `a < b`, positive if `a > b`, or `0` if equal.
   *
   * @throws If either version string is invalid
   */
  compare(a: string, b: string): number {
    if (this.customCompare) {
      return this.customCompare(a, b);
    }

    const aOrder = this.normalize(a);
    const bOrder = this.normalize(b);

    if (aOrder === null) {
      throw new Error(`Invalid version: "${a}"`);
    }
    if (bOrder === null) {
      throw new Error(`Invalid version: "${b}"`);
    }

    return aOrder - bOrder;
  }

  /**
   * Sort an array of version strings in ascending order (oldest first).
   *
   * @throws If any version string is invalid
   */
  sort(versions: string[]): string[] {
    return [...versions].sort((a, b) => this.compare(a, b));
  }

  /**
   * Get the current version name.
   */
  getCurrentVersion(): string {
    return this.versions[this.versions.length - 1]?.name ?? '';
  }

  /**
   * Resolve an alias to its target version name.
   * Returns the alias itself if it is not found in the alias map.
   *
   * @param version - The version string or alias to resolve
   * @returns The resolved version name
   */
  resolveAlias(version: string): string {
    return this.aliasMap.get(version) ?? version;
  }

  /**
   * Check if a version string is valid (known to the normalizer).
   *
   * @param version - The version string to check
   * @returns `true` if the version is known
   */
  isValid(version: string): boolean {
    const resolved = this.resolveAlias(version);
    return this.versionMap.has(resolved);
  }

  /**
   * Get the current version's internal order index.
   */
  getCurrentOrder(): number {
    return this.versions.length;
  }

  /**
   * Get a read-only list of all version definitions.
   */
  listVersions(): readonly VersionDefinition[] {
    return this.versions;
  }
}

/**
 * Generate date-based version strings from a start date to the current date.
 *
 * For 'monthly': generates YYYY-MM from the earliest reasonable start to current.
 * For 'daily': generates YYYY-MM-DD from the earliest reasonable start to current.
 *
 * Without an explicit start date in config, we use a 12-month lookback window
 * (the current month minus 12 months for monthly, or the current date minus 365
 * days for daily) as a reasonable default.
 */
function generateDateVersions(
  current: string,
  granularity: 'monthly' | 'daily',
  originalFormat?: string,
): string[] {
  // Normalize calver dot notation to ISO format for parsing
  const normalized = current.replace(/\./g, '-');
  const currentDate = new Date(normalized);
  if (isNaN(currentDate.getTime())) {
    return [current];
  }

  // Determine date separator: dash for standard, dot for calver
  const sep = originalFormat?.includes('.') ? '.' : '-';

  const versions: string[] = [];
  const isMonthly = granularity === 'monthly';

  // Start from 12 months / 365 days back
  const start = new Date(currentDate);
  if (isMonthly) {
    start.setMonth(start.getMonth() - 12);
    start.setDate(1);
  } else {
    start.setDate(start.getDate() - 365);
  }

  const cursor = new Date(start);
  while (cursor <= currentDate) {
    if (isMonthly) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, '0');
      versions.push(`${y}${sep}${m}`);
      cursor.setMonth(cursor.getMonth() + 1);
    } else {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, '0');
      const d = String(cursor.getDate()).padStart(2, '0');
      versions.push(`${y}${sep}${m}${sep}${d}`);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return versions;
}
