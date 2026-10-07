import type { VersionDefinition, VersionsConfig } from './types.js';

const MAX_GENERATED_VERSIONS = 10_000;

/** Maps external names and aliases to contiguous version orders. */
export class VersionNormalizer {
  private versions: VersionDefinition[] = [];
  private aliasMap = new Map<string, string>();
  private versionMap = new Map<string, number>();
  private reverseMap = new Map<number, string>();
  private customCompare?: (a: string, b: string) => number;

  constructor(
    config: VersionsConfig | undefined,
    private current: string,
  ) {
    if (!config) this.add({ name: current, order: 1 });
    else if (Array.isArray(config)) {
      const orders = new Set<number>();
      const definitions = config.map((v, index) =>
        typeof v === 'string' ? { name: v, order: index + 1 } : v,
      );
      for (const [index, version] of definitions.sort((a, b) => a.order - b.order).entries()) {
        if (!Number.isFinite(version.order) || orders.has(version.order))
          throw new Error(`Invalid or duplicate version order: ${version.order}`);
        orders.add(version.order);
        this.add({
          ...version,
          order: index + 1,
          ...(version.aliases ? { aliases: [...version.aliases] } : {}),
        });
        for (const alias of version.aliases ?? []) this.addAlias(alias, version.name);
      }
    } else if ('preset' in config) {
      this.addRange(generateDateVersions(current, 'YYYY-MM-DD', config.start, config.end));
    } else if (config.format === 'custom') {
      const parsed = config.parse(current);
      if (!Number.isSafeInteger(parsed.order) || parsed.order < 1)
        throw new Error('Custom version order must be a positive safe integer');
      this.customCompare = config.compare;
      this.add({ name: current, order: parsed.order });
    } else {
      for (const [alias, target] of Object.entries(config.aliases ?? {}))
        this.addAlias(alias, target);
      if (config.format === 'semantic' || config.format === 'numeric') {
        const prefix = config.format === 'semantic' ? (config.prefix ?? 'v') : '';
        const numeric = current.startsWith(prefix) ? current.slice(prefix.length) : '';
        const count = Number(numeric);
        if (
          !/^[1-9]\d*$/.test(numeric) ||
          !Number.isSafeInteger(count) ||
          count > MAX_GENERATED_VERSIONS
        ) {
          throw new Error(
            `Invalid ${config.format} current version: "${current}". Use an explicit version list for large or custom ranges.`,
          );
        }
        for (let order = 1; order <= count; order++) this.add({ name: `${prefix}${order}`, order });
      } else {
        const format =
          config.format === 'calver'
            ? (config.calverFormat ?? 'YYYY.MM')
            : (config.dateFormat ?? (config.format === 'date-monthly' ? 'YYYY-MM' : 'YYYY-MM-DD'));
        if (format.includes('DD') !== (config.format === 'date-daily'))
          throw new Error(`Invalid date format for ${config.format}: "${format}"`);
        this.addRange(generateDateVersions(current, format, config.start, config.end));
      }
    }
    for (const [alias, target] of this.aliasMap) {
      if (alias === target && this.versionMap.has(alias)) {
        this.aliasMap.delete(alias);
        continue;
      }
      if (this.versionMap.has(alias) && alias !== target)
        throw new Error(`Alias "${alias}" conflicts with a version name`);
      const seen = new Set([alias]);
      let resolved = target;
      while (this.aliasMap.has(resolved)) {
        if (seen.has(resolved)) throw new Error(`Circular version alias: "${alias}"`);
        seen.add(resolved);
        resolved = this.aliasMap.get(resolved)!;
      }
      if (!this.versionMap.has(resolved))
        throw new Error(`Alias "${alias}" targets unknown version "${resolved}"`);
      this.aliasMap.set(alias, resolved);
    }
    for (const version of this.versions) {
      if (version.aliases) Object.freeze(version.aliases);
      Object.freeze(version);
    }
    Object.freeze(this.versions);
  }

  private add(version: VersionDefinition): void {
    if (!version.name || this.versionMap.has(version.name))
      throw new Error(`Empty or duplicate version name: "${version.name}"`);
    this.versions.push(version);
    this.versionMap.set(version.name, version.order);
    this.reverseMap.set(version.order, version.name);
  }

  private addRange(names: string[]): void {
    for (const [index, name] of names.entries()) this.add({ name, order: index + 1 });
  }

  private addAlias(alias: string, target: string): void {
    if (!alias || (this.aliasMap.has(alias) && this.aliasMap.get(alias) !== target))
      throw new Error(`Empty or duplicate version alias: "${alias}"`);
    this.aliasMap.set(alias, target);
  }

  normalize(external: string): number | null {
    return this.versionMap.get(this.resolveAlias(external)) ?? null;
  }

  denormalize(internal: number): string | null {
    return this.reverseMap.get(internal) ?? null;
  }

  compare(a: string, b: string): number {
    if (this.customCompare) return this.customCompare(a, b);
    const first = this.normalize(a);
    const second = this.normalize(b);
    if (first === null) throw new Error(`Invalid version: "${a}"`);
    if (second === null) throw new Error(`Invalid version: "${b}"`);
    return first - second;
  }

  sort(versions: string[]): string[] {
    return [...versions].sort((a, b) => this.compare(a, b));
  }

  getCurrentVersion(): string {
    return this.resolveAlias(this.current);
  }

  resolveAlias(version: string): string {
    return this.aliasMap.get(version) ?? version;
  }

  isValid(version: string): boolean {
    return this.normalize(version) !== null;
  }

  getCurrentOrder(): number {
    return this.normalize(this.current) ?? 0;
  }

  listVersions(): readonly VersionDefinition[] {
    return this.versions;
  }
}

function generateDateVersions(
  current: string,
  format: string,
  start?: string,
  end?: string,
): string[] {
  const tokens: string[] = format.match(/YYYY|MM|DD/g) ?? [];
  if (
    tokens.filter((token) => token === 'YYYY').length !== 1 ||
    tokens.filter((token) => token === 'MM').length !== 1 ||
    tokens.filter((token) => token === 'DD').length > 1 ||
    /[a-z]/i.test(format.replace(/YYYY|MM|DD/g, ''))
  ) {
    throw new Error(`Unsupported date format: "${format}"`);
  }
  const daily = tokens.includes('DD');
  const pattern = new RegExp(
    `^${format
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/YYYY/g, '(\\d{4})')
      .replace(/MM|DD/g, '(\\d{2})')}$`,
  );
  const parse = (value: string): Date => {
    const match = pattern.exec(value);
    const year = Number(match?.[tokens.indexOf('YYYY') + 1]);
    const month = Number(match?.[tokens.indexOf('MM') + 1]);
    const day = daily ? Number(match?.[tokens.indexOf('DD') + 1]) : 1;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (
      !match ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      throw new Error(`Invalid date version: "${value}"`);
    return date;
  };
  const currentDate = parse(current);
  const endDate = end ? parse(end) : currentDate;
  const startDate = start ? parse(start) : new Date(currentDate);
  if (!start) {
    if (daily) startDate.setUTCDate(startDate.getUTCDate() - 365);
    else startDate.setUTCMonth(startDate.getUTCMonth() - 12);
  }
  if (startDate > currentDate || endDate < currentDate)
    throw new Error('Date range must contain the current version');
  const versions: string[] = [];
  for (const cursor = new Date(startDate); cursor <= endDate; ) {
    if (versions.length === MAX_GENERATED_VERSIONS)
      throw new Error(
        'Date range exceeds 10000 versions; use an explicit version list for sparse releases',
      );
    versions.push(
      format.replace(/YYYY|MM|DD/g, (token) =>
        token === 'YYYY'
          ? String(cursor.getUTCFullYear()).padStart(4, '0')
          : String(token === 'MM' ? cursor.getUTCMonth() + 1 : cursor.getUTCDate()).padStart(
              2,
              '0',
            ),
      ),
    );
    if (daily) cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return versions;
}
