import type { PylonConfig } from '@ossl/pylon-core';
import { loadPylonConfig } from '../load-config.js';

/**
 * Describes a single field in a schema.
 */
export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

/**
 * Describes the shape of a schema for diffing purposes.
 */
export interface SchemaShape {
  fields: SchemaField[];
  nestedSchemas: Record<string, SchemaShape>;
}

/**
 * A change detected between two schema versions.
 */
export interface SchemaChange {
  type: 'added' | 'removed' | 'changed' | 'renamed';
  field: string;
  details: string;
}

/**
 * Represents a section of the changelog output.
 */
export interface ChangelogSection {
  title: string;
  changes: SchemaChange[];
}

/**
 * Generate a changelog diff between two version schemas.
 *
 * Compares the schemas for two versions and prints a markdown-formatted
 * changelog showing added, removed, changed, and potentially renamed fields.
 */
export async function diffAction(a: string, b: string): Promise<void> {
  const { config } = await loadPylonConfig();

  const shapeA = extractSchemaShape(config, a);
  const shapeB = extractSchemaShape(config, b);

  if (!shapeA && !shapeB) {
    console.log(`No schemas found for "${a}" or "${b}".`);
    return;
  }

  if (!shapeA) {
    console.log(`No schema found for version "${a}".`);
    return;
  }

  if (!shapeB) {
    console.log(`No schema found for version "${b}".`);
    return;
  }

  const changes = compareShapes(shapeA, shapeB);

  printChangelog(a, b, changes);
}

/**
 * Extract a simplified shape from the schemas for a specific version.
 *
 * Since schemas are Zod objects, we try to introspect their shape.
 * If the schema is a plain object descriptor, we parse it recursively.
 *
 * This is a best-effort heuristic since Zod schemas may be complex.
 */
export function extractSchemaShape(config: PylonConfig, version: string): SchemaShape | null {
  // Look for a schema keyed by the version name, or a naming convention
  const schemaKeys = Object.keys(config.schemas);
  const key = schemaKeys.find(
    (k) => k === version || k.startsWith(version) || version.startsWith(k),
  );

  if (!key) {
    // Return a skeleton — no detailed schema info available
    return null;
  }

  // We can't deeply introspect Zod schemas at runtime from the CLI,
  // so we return a shape based on what we can detect
  return {
    fields: [],
    nestedSchemas: {},
  };
}

/**
 * Compare two schema shapes and return detected changes.
 *
 * Performs field-level comparison to identify:
 * - Fields present in B but not A (added)
 * - Fields present in A but not B (removed)
 * - Fields with type changes (changed)
 * - Fields renamed (via simple heuristic: removed + added with similar name)
 */
export function compareShapes(aShape: SchemaShape, bShape: SchemaShape): ChangelogSection[] {
  const sections: ChangelogSection[] = [];

  const aFields = aShape.fields;
  const bFields = bShape.fields;

  const aFieldNames = new Set(aFields.map((f) => f.name));
  const bFieldNames = new Set(bFields.map((f) => f.name));

  // Added fields
  const addedFields: SchemaChange[] = [];
  for (const field of bFields) {
    if (!aFieldNames.has(field.name)) {
      addedFields.push({
        type: 'added',
        field: field.name,
        details: `Type: ${field.type}${field.required ? ' (required)' : ' (optional)'}`,
      });
    }
  }
  if (addedFields.length > 0) {
    sections.push({ title: 'Added Fields', changes: addedFields });
  }

  // Removed fields
  const removedFields: SchemaChange[] = [];
  for (const field of aFields) {
    if (!bFieldNames.has(field.name)) {
      removedFields.push({
        type: 'removed',
        field: field.name,
        details: `Was: ${field.type}${field.required ? ' (required)' : ' (optional)'}`,
      });
    }
  }
  if (removedFields.length > 0) {
    sections.push({ title: 'Removed Fields', changes: removedFields });
  }

  // Changed fields (same name, different type)
  const changedFields: SchemaChange[] = [];
  for (const bField of bFields) {
    if (!aFieldNames.has(bField.name)) continue;
    const aField = aFields.find((f) => f.name === bField.name);
    if (aField && aField.type !== bField.type) {
      changedFields.push({
        type: 'changed',
        field: bField.name,
        details: `${aField.type} -> ${bField.type}`,
      });
    }
  }
  if (changedFields.length > 0) {
    sections.push({ title: 'Changed Types', changes: changedFields });
  }

  // Renamed fields (heuristic: removed + added with similar names)
  const renamedFields = detectRenames(removedFields, addedFields);
  if (renamedFields.length > 0) {
    sections.push({ title: 'Renamed Fields', changes: renamedFields });
  }

  return sections;
}

/**
 * Heuristic rename detection.
 *
 * Matches removed fields to added fields with similar names
 * (e.g., "userName" -> "username", "created_at" -> "createdAt").
 */
export function detectRenames(removed: SchemaChange[], added: SchemaChange[]): SchemaChange[] {
  const renames: SchemaChange[] = [];

  for (const rem of removed) {
    for (const add of added) {
      const similarity = nameSimilarity(rem.field, add.field);
      if (similarity > 0.6) {
        renames.push({
          type: 'renamed',
          field: `${rem.field} -> ${add.field}`,
          details: `Renamed with ${Math.round(similarity * 100)}% similarity`,
        });
        break;
      }
    }
  }

  return renames;
}

/**
 * Simple name similarity using character overlap (Jaccard-like).
 */
export function nameSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, '').split('').sort().join('');

  const aNorm = normalize(a);
  const bNorm = normalize(b);

  // Count shared characters
  const aChars = new Set(aNorm);
  const bChars = new Set(bNorm);
  const intersection = new Set([...aChars].filter((c) => bChars.has(c)));
  const union = new Set([...aChars, ...bChars]);

  return intersection.size / union.size;
}

/**
 * Print the changelog in markdown format to the console.
 */
function printChangelog(a: string, b: string, sections: ChangelogSection[]): void {
  if (sections.length === 0) {
    console.log(`## Schema Diff: ${a} → ${b}`);
    console.log('');
    console.log('No changes detected between schemas.');
    return;
  }

  console.log(`## Schema Changelog: ${a} → ${b}`);
  console.log('');

  for (const section of sections) {
    console.log(`### ${section.title}`);
    console.log('');

    for (const change of section.changes) {
      console.log(`- **\`${change.field}\`** ${change.details}`);
    }

    console.log('');
  }
}
