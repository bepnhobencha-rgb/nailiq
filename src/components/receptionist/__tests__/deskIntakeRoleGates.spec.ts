import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { canCreateDeskBooking, type SalonMemberRole } from "@/shared/lib/salonMemberRole";

// Exercise the actual JSX/input gate expressions across every canonical role.
// This source-level regression supplements the authenticated browser suite;
// it does not establish hosted UI or database authorization by itself.
const path = resolve("src/components/receptionist/ReceptionistCenter.tsx");
const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes: ts.Node[] = [];
function visit(node: ts.Node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);

function propExpressions(name: string): ts.Expression[] {
  return nodes.flatMap((node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === name &&
        node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      return [node.initializer.expression];
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) return [node.initializer];
    return [];
  });
}

function renderGate(tag: string, testId?: string): ts.Expression {
  const element = nodes.find((node) => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return false;
    return node.tagName.getText(source) === tag && (!testId || node.attributes.properties.some((attr) =>
      ts.isJsxAttribute(attr) && attr.name.getText(source) === "data-testid" &&
      attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === testId));
  });
  if (!element) throw new Error(`Missing rendered control: ${tag}/${testId}`);
  let node: ts.Node = element;
  while (node.parent) {
    node = node.parent;
    if (ts.isConditionalExpression(node)) return node.condition;
  }
  throw new Error(`Missing render guard: ${tag}/${testId}`);
}

const controls = [
  ...propExpressions("canAddGroup").map((expression, i) => ({ name: `group menu ${i}`, expression })),
  ...propExpressions("showQuickAdd").map(expression => ({ name: "queue intake", expression })),
  ...propExpressions("walkinIntakeOpen").map(expression => ({ name: "walk-in suggestion", expression })),
  { name: "classic group button", expression: renderGate("Button", "header-add-group") },
  { name: "appointment form", expression: renderGate("DeskBookingForm") },
  { name: "group form", expression: renderGate("DeskGroupForm") },
  { name: "mobile client intake", expression: renderGate("HeaderCustomerSearch") },
];

function allowed(expression: ts.Expression, viewerRole: SalonMemberRole) {
  const context = {
    viewerRole, canCreateDeskBooking, viewMode: "day", groupBookingEnabled: true,
    modules: { quick_add: true }, walkinPrefill: null,
    walkinIntakeOpenForSelectedDay: true, receptionistShellV2Enabled: false,
    deskBookingOpen: true, deskGroupOpen: true, isMobile: true,
  };
  return Boolean(Function(...Object.keys(context), `return (${expression.getText(source)});`)(...Object.values(context)));
}

describe("desk intake controls use the same role boundary as the server", () => {
  it("covers every discovered intake entry point", () => {
    expect(propExpressions("canAddGroup")).toHaveLength(2);
    expect(propExpressions("showQuickAdd")).toHaveLength(1);
    expect(propExpressions("walkinIntakeOpen")).toHaveLength(1);
    expect(controls).toHaveLength(8);
  });
  for (const role of ["owner", "admin", "senior", "receptionist", "nail_tech"] as const) {
    it.each(controls)(`${role}: $name`, ({ expression }) => {
      expect(allowed(expression, role)).toBe(role !== "nail_tech");
    });
  }
});
