import { isDeepStrictEqual } from 'node:util';
import type { PylonConfig } from '@ossl/pylon-core';
import { zodToOpenAPISchema } from '@ossl/pylon-openapi';
import { loadPylonConfig } from '../load-config.js';
import { type SchemaOptions, selectSchema } from './schema.js';

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
export async function diffAction(
  a: string,
  b: string,
  options: SchemaOptions & { json?: boolean } = {},
): Promise<void> {
  const { config } = await loadPylonConfig();
  const source = selectSchema(config, a, options);
  const target = selectSchema(config, b, options);
  const io = source.direction === 'request' ? 'input' : 'output';
  const changes = diffSchemas(
    zodToOpenAPISchema(source.schema, io),
    zodToOpenAPISchema(target.schema, io),
  );
  if (options.json) console.log(JSON.stringify(changes, null, 2));
  else printChangelog(a, b, changes.length ? [{ title: 'Contract Changes', changes }] : []);
}

/** Diff JSON schema assertions, including nested fields and constraints. Renames require human intent. */
export function diffSchemas(a: unknown, b: unknown, path = ''): SchemaChange[] {
  return walkSchemas(a, b, path, true);
}

function sameValues(a: unknown[], b: unknown[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  const contains = (values: Set<unknown>, value: unknown): boolean => {
    if (values.has(value)) return true;
    if (value === null || typeof value !== 'object') return false;
    for (const candidate of values) if (isDeepStrictEqual(value, candidate)) return true;
    return false;
  };
  for (const value of left) if (!contains(right, value)) return false;
  for (const value of right) if (!contains(left, value)) return false;
  return true;
}

function walkSchemas(a: unknown, b: unknown, path: string, schemaObject: boolean): SchemaChange[] {
  if (isDeepStrictEqual(a, b)) return [];
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const changes: SchemaChange[] = [];
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (schemaObject && ['$schema', 'description', 'title'].includes(key)) continue;
      const oldValue = left[key];
      const newValue = right[key];
      if (
        schemaObject &&
        ['required', 'enum', 'type'].includes(key) &&
        Array.isArray(oldValue) &&
        Array.isArray(newValue) &&
        sameValues(oldValue, newValue)
      )
        continue;
      const field = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!Object.hasOwn(left, key))
        changes.push({ type: 'added', field, details: JSON.stringify(right[key]) });
      else if (!Object.hasOwn(right, key))
        changes.push({ type: 'removed', field, details: JSON.stringify(left[key]) });
      else
        changes.push(
          ...walkSchemas(
            oldValue,
            newValue,
            field,
            !schemaObject ||
              ![
                'properties',
                'patternProperties',
                '$defs',
                'definitions',
                'dependentSchemas',
              ].includes(key),
          ),
        );
    }
    return changes;
  }
  return [
    {
      type: 'changed',
      field: path || '/',
      details: `${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
    },
  ];
}

export function extractSchemaShape(config: PylonConfig, version: string): SchemaShape | null {
  const schema = config.schemas[version];
  if (!schema) return null;
  const json = zodToOpenAPISchema(schema, 'input');
  const properties = json.properties as Record<string, Record<string, unknown>> | undefined;
  const required = new Set((json.required ?? []) as string[]);
  return {
    fields: Object.entries(properties ?? {}).map(([name, value]) => ({
      name,
      type: typeof value.type === 'string' ? value.type : JSON.stringify(value),
      required: required.has(name),
    })),
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
    if (aField && (aField.type !== bField.type || aField.required !== bField.required)) {
      changedFields.push({
        type: 'changed',
        field: bField.name,
        details:
          aField.required !== bField.required
            ? `${aField.type} (${aField.required ? 'required' : 'optional'}) -> ${bField.type} (${bField.required ? 'required' : 'optional'})`
            : `${aField.type} -> ${bField.type}`,
      });
    }
  }
  if (changedFields.length > 0) {
    sections.push({ title: 'Changed Types', changes: changedFields });
  }

  // Renamed fields (heuristic: removed + added with similar names)
  const renamedFields = detectRenames(removedFields, addedFields);
  if (renamedFields.length > 0) {
    sections.push({ title: 'Possible Renames', changes: renamedFields });
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
