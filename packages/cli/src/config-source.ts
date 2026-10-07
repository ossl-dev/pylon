import type { PylonConfig } from '@ossl/pylon-core';
import ts from 'typescript';

/** Replace only version metadata; runtime schemas, functions, and comments stay intact. */
export function updateConfigSource(source: string, config: PylonConfig): string {
  const file = ts.createSourceFile('pylon.config.ts', source, ts.ScriptTarget.Latest, true);
  const diagnostics = ts.transpileModule(source, { reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error('Cannot safely edit a config containing syntax errors');
  }
  const variables = new Map<string, ts.Expression>();
  let exported: ts.Expression | undefined;
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals)
      exported = statement.expression;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          variables.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const seen = new Set<ts.Expression>();
  function object(expression: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
    if (!expression || seen.has(expression)) return;
    seen.add(expression);
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return object(expression.expression);
    if (ts.isIdentifier(expression)) return object(variables.get(expression.text));
    if (
      ts.isCallExpression(expression) &&
      expression.arguments.length === 1 &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'defineConfig'
    )
      return object(expression.arguments[0]);
  }
  const configObject = object(exported);
  if (!configObject || configObject.properties.some(ts.isSpreadAssignment)) {
    throw new Error(
      'Cannot safely edit this config. Use a default-exported object or defineConfig({...}) without object spreads.',
    );
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const additions: string[] = [];
  for (const [name, value] of Object.entries({
    current: config.current,
    versions: config.versions,
  })) {
    if (value === undefined) continue;
    const matches = configObject.properties.filter(
      (property) =>
        property.name &&
        !ts.isComputedPropertyName(property.name) &&
        property.name.getText(file).replace(/^['"]|['"]$/g, '') === name,
    );
    if (matches.length > 1) throw new Error(`Cannot safely edit duplicate "${name}" fields`);
    const text = JSON.stringify(value, null, 2);
    const property = matches[0];
    if (!property) additions.push(`  ${name}: ${text},`);
    else if (ts.isPropertyAssignment(property))
      edits.push({
        start: property.initializer.getStart(file),
        end: property.initializer.end,
        text,
      });
    else if (ts.isShorthandPropertyAssignment(property))
      edits.push({ start: property.getStart(file), end: property.end, text: `${name}: ${text}` });
    else throw new Error(`Cannot safely edit "${name}"`);
  }
  if (additions.length) {
    const position = configObject.end - 1;
    const comma =
      configObject.properties.length && !configObject.properties.hasTrailingComma ? ',' : '';
    edits.push({ start: position, end: position, text: `${comma}\n${additions.join('\n')}\n` });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
