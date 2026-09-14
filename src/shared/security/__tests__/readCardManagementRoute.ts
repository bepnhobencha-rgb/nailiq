import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";

/** Follow only the exact reviewed route adapter, then inspect its own handler. */
export function readCardManagementRoute(relative: string): string {
  const handler = relative === "src/app/api/booking/card-capability/route.ts"
    ? "handleBookingCardCapability"
    : relative === "src/app/api/booking/square-save-card/route.ts" ? "handleBookingCardSave" : null;
  if (!handler) throw new Error("unsupported_card_route_reader");
  const route = readFileSync(resolve(process.cwd(), relative), "utf8");
  const runtime = handler === "handleBookingCardSave" ? 'export const runtime = "nodejs";\n\n' : "";
  expect(route).toBe(`import { ${handler} } from "@/shared/booking/bookingCardManagementServer";\n\n${runtime}export async function POST(request: Request) {\n  return ${handler}(request);\n}\n`);
  const source = readFileSync(resolve(process.cwd(), "src/shared/booking/bookingCardManagementServer.ts"), "utf8");
  expect(source.startsWith('import "server-only";')).toBe(true);
  const start = source.indexOf(`export async function ${handler}(request: Request) {`);
  const end = source.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // Do not concatenate the other handler: its guard could mask a missing guard
  // in the public route being checked. Shared response headers are not authority.
  const headersStart = source.indexOf("const PRIVATE_HEADERS = {");
  const headersEnd = source.indexOf("} as const;", headersStart);
  expect(headersStart).toBeGreaterThan(0);
  expect(headersEnd).toBeGreaterThan(headersStart);
  return source.slice(headersStart, headersEnd + 11) + "\n" + source.slice(start, end + 3);
}
