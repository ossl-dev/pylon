import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

/**
 * Result of auditing a codebase for versioning patterns.
 */
export interface AuditResult {
  /** Total number of endpoints detected */
  totalEndpoints: number;
  /** Distribution of versioning patterns found */
  patterns: Array<{ type: string; count: number; description: string }>;
  /** All detected version strings */
  detectedVersions: string[];
  /** Individual endpoint details */
  endpoints: Array<{ path: string; methods: string[]; versions: string[] }>;
  /** Suggested next steps */
  suggestions: string[];
}

// Patterns for detecting versioning in source code
const ROUTE_PATTERN = /(?:router|app|route|endpoint)\.(get|post|put|patch|delete|options|head)\s*[\(\/]\s*['"`][^'"`]*['"`]/gi;
const VERSION_IN_PATH = /\/(v\d+)\//g;
const VERSION_CHECK = /(?:apiVersion|version|api_version)\s*[=:]\s*['"]([^'"]+)['"]/gi;
const VERSION_HEADER = /(?:accept-version|api-version|x-api-version)/gi;
const VERSION_SWITCH = /switch\s*\(\s*(?:version|apiVersion)\s*\)/gi;
const VERSION_IF = /if\s*\(\s*(?:version|apiVersion)\s*[=!]==?\s*['"]([^'"]+)['"]/gi;

/**
 * Skip directories during audit.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  'build',
  'coverage',
  '.cache',
]);

/**
 * Analyze a codebase for versioning patterns.
 *
 * Scans source files for route handlers, version checks, and version strings
 * to produce a report of detected API versioning patterns.
 */
export async function auditAction(path: string): Promise<void> {
  const resolvedPath = resolve(path);

  if (!statSync(resolvedPath, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Path "${resolvedPath}" is not a valid directory.`);
    process.exit(1);
  }

  console.error(`Auditing ${resolvedPath} for versioning patterns...\n`);

  const result = scanCodebase(resolvedPath);

  printAuditReport(result);
}

/**
 * Scan the codebase and produce an audit result.
 */
export function scanCodebase(rootDir: string): AuditResult {
  const allEndpoints: AuditResult['endpoints'] = [];
  const patternCounts = new Map<string, number>();
  const versionSet = new Set<string>();

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          if (!SKIP_DIRS.has(entry) && !entry.startsWith('.')) {
            walk(fullPath);
          }
          continue;
        }

        if (!stats.isFile()) continue;

        const ext = extname(fullPath);
        if (!['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) continue;

        const content = readFileSync(fullPath, 'utf-8');
        const relativePath = pathToRelative(rootDir, fullPath);

        // Detect routes/endpoints
        const routeMethods: string[] = [];
        let routeMatch: RegExpExecArray | null;
        const routeRegex = new RegExp(ROUTE_PATTERN.source, 'gi');
        while ((routeMatch = routeRegex.exec(content)) !== null) {
          const method = routeMatch[1]?.toUpperCase();
          if (method && !routeMethods.includes(method)) {
            routeMethods.push(method);
          }
        }
        // Note: routeRegex.lastIndex cannot be used to detect matches —
        // exec() resets it to 0 when it returns null.
        if (routeMethods.length > 0) {
          patternCounts.set('route_handlers', (patternCounts.get('route_handlers') ?? 0) + routeMethods.length);
        }

        // Detect versions in paths
        const pathVersions: string[] = [];
        const versionInPathRegex = new RegExp(VERSION_IN_PATH.source, 'g');
        let pathMatch: RegExpExecArray | null;
        while ((pathMatch = versionInPathRegex.exec(content)) !== null) {
          if (pathMatch[1] && !pathVersions.includes(pathMatch[1])) {
            pathVersions.push(pathMatch[1]);
            versionSet.add(pathMatch[1]);
          }
        }

        // Detect version checks
        const versionCheckRegex = new RegExp(VERSION_CHECK.source, 'gi');
        let checkMatch: RegExpExecArray | null;
        while ((checkMatch = versionCheckRegex.exec(content)) !== null) {
          if (checkMatch[1]) {
            versionSet.add(checkMatch[1]);
          }
        }

        // Detect version headers
        if (VERSION_HEADER.test(content)) {
          patternCounts.set('version_headers', (patternCounts.get('version_headers') ?? 0) + 1);
        }

        // Detect switch on version
        if (VERSION_SWITCH.test(content)) {
          patternCounts.set('version_switch', (patternCounts.get('version_switch') ?? 0) + 1);
        }

        // Detect version if/else
        const versionIfRegex = new RegExp(VERSION_IF.source, 'gi');
        let ifMatch: RegExpExecArray | null;
        while ((ifMatch = versionIfRegex.exec(content)) !== null) {
          if (ifMatch[1]) {
            versionSet.add(ifMatch[1]);
          }
        }

        if (routeMethods.length > 0 || pathVersions.length > 0) {
          allEndpoints.push({
            path: relativePath,
            methods: routeMethods,
            versions: pathVersions,
          });
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  walk(rootDir);

  // Build pattern descriptions
  const patterns: AuditResult['patterns'] = [];
  for (const [type, count] of patternCounts) {
    const descriptions: Record<string, string> = {
      route_handlers: 'Route handler definitions found',
      version_headers: 'Version header checks found (Accept-Version, Api-Version, etc.)',
      version_switch: 'Switch statements on version',
    };
    patterns.push({
      type,
      count,
      description: descriptions[type] ?? type,
    });
  }

  // Generate suggestions
  const suggestions = generateSuggestions(allEndpoints, [...versionSet]);

  return {
    totalEndpoints: allEndpoints.length,
    patterns,
    detectedVersions: [...versionSet].sort(),
    endpoints: allEndpoints,
    suggestions,
  };
}

/**
 * Convert an absolute path to a project-relative path.
 */
function pathToRelative(rootDir: string, fullPath: string): string {
  return fullPath.replace(rootDir, '').replace(/^\//, '') || '.';
}

/**
 * Generate actionable suggestions based on audit findings.
 */
export function generateSuggestions(
  _endpoints: AuditResult['endpoints'],
  detectedVersions: string[],
): string[] {
  const suggestions: string[] = [];

  if (detectedVersions.length === 0) {
    suggestions.push('No versioning patterns detected. Consider adding explicit version management.');
    suggestions.push('Run "pylon init" to create a pylon.config.ts.');
    return suggestions;
  }

  if (detectedVersions.length > 1) {
    suggestions.push(
      `Detected ${detectedVersions.length} versions: ${detectedVersions.join(', ')}. ` +
        'Consider centralizing version management with Pylon.',
    );
  }

  suggestions.push('Define schemas for each version to enable automatic validation.');
  suggestions.push(
    'Create transform functions between versions to handle request/response migration.',
  );
  suggestions.push('Run "pylon init --from-existing ./src" to generate a config from this analysis.');

  return suggestions;
}

/**
 * Pretty-print the audit report to the console.
 */
function printAuditReport(result: AuditResult): void {
  const separator = '─'.repeat(50);

  console.log(separator);
  console.log('  API Versioning Audit Report');
  console.log(separator);
  console.log('');

  // Summary
  console.log(`  Total endpoints detected:  ${result.totalEndpoints}`);
  console.log(`  Unique versions found:     ${result.detectedVersions.length}`);
  console.log('');

  // Detected versions
  if (result.detectedVersions.length > 0) {
    console.log('  Detected Versions:');
    for (const v of result.detectedVersions) {
      console.log(`    - ${v}`);
    }
    console.log('');
  }

  // Patterns
  if (result.patterns.length > 0) {
    console.log('  Versioning Patterns:');
    for (const p of result.patterns) {
      console.log(`    ${p.type.padEnd(20)} ${p.count.toString().padStart(4)}  ${p.description}`);
    }
    console.log('');
  }

  // Endpoints (limit to first 20)
  if (result.endpoints.length > 0) {
    const display = result.endpoints.slice(0, 20);
    console.log('  Endpoints:');
    for (const ep of display) {
      const methods = ep.methods.length > 0 ? ` [${ep.methods.join(', ')}]` : '';
      const versions = ep.versions.length > 0 ? ` versions: ${ep.versions.join(', ')}` : '';
      console.log(`    - ${ep.path}${methods}${versions}`);
    }
    if (result.endpoints.length > 20) {
      console.log(`    ... and ${result.endpoints.length - 20} more`);
    }
    console.log('');
  }

  // Suggestions
  if (result.suggestions.length > 0) {
    console.log('  Suggestions:');
    for (const s of result.suggestions) {
      console.log(`    * ${s}`);
    }
    console.log('');
  }

  console.log(separator);
}
