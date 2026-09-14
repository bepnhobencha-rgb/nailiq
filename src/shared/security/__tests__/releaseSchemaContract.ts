import ts from "typescript";
import { expect } from "vitest";

// Exact candidate measured by the 522-migration blank-DB/delta rehearsals,
// then the disposable R07 migration rehearsal: one OTP assurance column and
// one booking-only validator added (release-r07-schema-parity-before-update.log).
// R09 adds 17 functions (proof overloads, private/desk guards, paid replay),
// measured in the combined offline disposable database on 2026-09-13.
// R10 adds 10 columns, 3 private functions and 2 indexes, measured by
// r10-schema-before-contract.log on the isolated QA clone.
// R11 combines current Production: +8 columns, +6 functions, +1 trigger,
// +3 indexes; plus +1 service-only expired-grace pause function.
// P1-01 adds one service-only Waitlist terminal-delivery truth projection.
// This is the local release contract, not a claim about Production's schema.
const EXPECTED_RELEASE_SHAPE = {
  tables: 246,
  columns: 3798,
  policies: 225,
  functions: 595,
  triggers: 162,
  indexes: 1012,
};
const EXPECTED_GRANTS = { anon: 56, authenticated: 78, service_role: 233 };

function numericObject(source: string, name: string): Record<string, number> {
  const file = ts.createSourceFile("check-schema-parity.ts", source, ts.ScriptTarget.Latest, true);
  const matches: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(matches, `one exact ${name} declaration`).toHaveLength(1);
  let expression = matches[0].initializer;
  while (expression && (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression))) expression = expression.expression;
  expect(expression && ts.isObjectLiteralExpression(expression), `${name} must stay an explicit object`).toBe(true);
  const fields: Record<string, number> = {};
  for (const property of (expression as ts.ObjectLiteralExpression).properties) {
    expect(ts.isPropertyAssignment(property), `${name} cannot contain a spread`).toBe(true);
    const assignment = property as ts.PropertyAssignment;
    expect(ts.isIdentifier(assignment.name), `${name} keys must be explicit`).toBe(true);
    expect(ts.isNumericLiteral(assignment.initializer), `${name} counts must be exact literals`).toBe(true);
    const key = (assignment.name as ts.Identifier).text;
    expect(fields).not.toHaveProperty(key);
    fields[key] = Number((assignment.initializer as ts.NumericLiteral).text);
  }
  return fields;
}

/** Share the measured totals; individual boundary specs retain their own
 * critical table/RPC/RLS assertions. Never replace exact equality with minima. */
export function assertReleaseSchemaContract(source: string) {
  expect(numericObject(source, "RELEASE_SHAPE")).toEqual(EXPECTED_RELEASE_SHAPE);
  expect(numericObject(source, "GRANTS")).toEqual(EXPECTED_GRANTS);
}
