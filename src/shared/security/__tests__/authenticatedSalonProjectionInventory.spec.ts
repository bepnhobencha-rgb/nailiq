import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  loadSalonMemberOperationalProfile,
  loadSalonOwnerAdminSettings,
} from "@/shared/dashboard/salonOwnerAdminSettings";

const OPERATIONAL_COLUMNS = new Set(
  `id slug name created_at address salon_phone opening_hours profile_complete
   booking_closed_dates closure_notice timezone dashboard_modules
   dashboard_preset dashboard_density setup_wizard_completed_at
   subscription_plan plan_override brand_color theme_mode
   currency_code description phone_otp_enabled voice_ai_enabled
   basic_mode_forced walkin_auto_assign queue_display_mode vertical
   public_sections_enabled booking_images staff_selection_enabled
   booking_lead_minutes group_together_threshold_minutes group_wave_strategy
   reference_image_enabled auto_no_show_minutes noshow_protection_enabled
   winback_enabled default_notification_locale health_ack_required
   email_links_enabled resources_enabled primary_grid_axis tax_lines
   privacy_url terms_url default_language logo_url archived_at`
    .trim()
    .split(/\s+/),
);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function stringValue(node: ts.Expression): string | null {
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return stringValue(node.expression);
  }
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringValue(node.left);
    const right = stringValue(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function selectedColumns(value: string): string[] {
  return value
    .split(",")
    .map((column) => column.trim().split(/[\s(:!]/, 1)[0])
    .filter(Boolean);
}

function isInsideDemoCookieGuard(node: ts.Node, sf: ts.SourceFile): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isIfStatement(current) &&
      current.expression.getText(sf).includes("ctx.kind") &&
      current.expression.getText(sf).includes("demo_cookie")
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

describe("authenticated salons projection inventory", () => {
  it("keeps every authenticated dashboard salons SELECT on operational columns", () => {
    const srcRoot = resolve(process.cwd(), "src");
    const violations: string[] = [];

    for (const file of sourceFiles(srcRoot)) {
      if (file.includes(`${join("", "__tests__")}`)) continue;
      const source = readFileSync(file, "utf8");
      const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "select"
        ) {
          const receiver = node.expression.expression.getText(sf);
          const isSalonSelect =
            receiver.includes('.from("salons")') ||
            receiver.includes(".from('salons')");
          const serviceReceiver =
            receiver.includes("createServiceRoleClient") ||
            /^(?:admin|db|serviceDb)(?:\.|\s)/.test(receiver.trim());
          const appRequestSurface =
            file.includes(`${join("app", "dashboard")}`) ||
            file.includes(`${join("app", "choose-salon")}`) ||
            file.includes(`${join("app", "register")}`) ||
            file.includes(`${join("app", "staff")}`);
          const sharedRequestSurface =
            file.includes(`${join("shared", "dashboard")}`) ||
            file.includes(`${join("shared", "features")}`) ||
            file.includes(`${join("shared", "loyalty")}`) ||
            file.includes(`${join("shared", "register")}`) ||
            file.endsWith(`${join("shared", "lib", "salonMembership.ts")}`);
          const knownServiceAlias = [
            join("shared", "dashboard", "stripeActions.ts"),
            join("shared", "dashboard", "drcThemeAction.ts"),
            join("shared", "loyalty", "loyaltyActions.ts"),
          ].some((suffix) => file.endsWith(suffix));
          const authenticatedRequest =
            !serviceReceiver &&
            !knownServiceAlias &&
            !isInsideDemoCookieGuard(node, sf) &&
            (appRequestSurface || sharedRequestSurface);
          const requestContext = receiver.includes("ctx.supabase");
          if (isSalonSelect && (authenticatedRequest || requestContext)) {
            const value = node.arguments[0]
              ? stringValue(node.arguments[0])
              : null;
            const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            if (value === null) {
              violations.push(`${relative(srcRoot, file)}:${line}:dynamic-select`);
            } else {
              for (const column of selectedColumns(value)) {
                if (column !== "*" && !OPERATIONAL_COLUMNS.has(column)) {
                  violations.push(
                    `${relative(srcRoot, file)}:${line}:${column}`,
                  );
                }
              }
            }
          }

          // UPDATE ... SELECT requires SELECT privilege on every returned
          // column. All authenticated salon mutations return only safe keys.
          if (isSalonSelect && receiver.includes(".update(")) {
            const value = node.arguments[0]
              ? stringValue(node.arguments[0])
              : null;
            const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            if (
              value === null ||
              selectedColumns(value).some(
                (column) => column !== "*" && !OPERATIONAL_COLUMNS.has(column),
              )
            ) {
              violations.push(
                `${relative(srcRoot, file)}:${line}:unsafe-update-returning`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(violations).toEqual([]);
  });

  it("keeps the DB member contract normalized and owner PII out", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260820233000_harden_authenticated_salon_column_access.sql",
      ),
      "utf8",
    );
    const memberStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.load_salon_member_operational_profile",
    );
    const ownerStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.load_salon_owner_admin_settings",
    );
    const memberContract = migration.slice(memberStart, ownerStart);

    expect(migration).toContain(
      "REVOKE SELECT ON TABLE public.salons FROM authenticated",
    );
    expect(memberContract).toContain("VOLATILE");
    expect(memberContract).toContain("FOR SHARE");
    expect(memberContract).toContain("'client_segment_settings'");
    expect(memberContract).toContain("'staff_notification_settings'");
    expect(memberContract).toContain("'noshow_protection_enabled'");
    expect(memberContract).toContain("'winback_enabled'");
    expect(memberContract).toContain("pg_catalog.jsonb_each");
    expect(memberContract).toContain("'^#[0-9A-Fa-f]{6}$'");
    expect(memberContract).not.toMatch(/'email'\s*,\s*s\.email/);
    expect(memberContract).not.toMatch(/'phone'\s*,\s*s\.phone/);
    expect(memberContract).not.toMatch(
      /s\.(?:stripe_|admin_notes|tenant_pause)/,
    );
  });

  it("keeps the remaining raw service-role reads behind server-owned guards", () => {
    const cases = [
      {
        file: "src/shared/dashboard/drcThemeAction.ts",
        guard: /getDashboardWriteClient[\s\S]*?isOwner/,
      },
      {
        file: "src/shared/loyalty/loyaltyActions.ts",
        guard: /resolveSalonForDashboard[\s\S]*?createServiceRoleClient/,
      },
      {
        file: "src/shared/dashboard/stripeActions.ts",
        guard: /resolveSalonForDashboard[\s\S]*?isOwner[\s\S]*?createServiceRoleClient/,
      },
    ];
    for (const item of cases) {
      const source = readFileSync(resolve(process.cwd(), item.file), "utf8");
      expect(source).toMatch(item.guard);
    }
  });
});

describe("salon profile RPC executable boundary", () => {
  it.each(["owner", "admin", "senior", "receptionist", "nail_tech"] as const)(
    "accepts a same-salon %s operational profile without a table loader",
    async (role) => {
      const client = {
        from: vi.fn(),
        rpc: vi.fn().mockResolvedValue({
          data: {
            success: true,
            code: "loaded",
            role,
            salon_id: "salon-1",
            salon: { id: "salon-1", slug: "qa-salon" },
          },
          error: null,
        }),
      };

      await expect(
        loadSalonMemberOperationalProfile(client as never, "salon-1"),
      ).resolves.toEqual({
        ok: true,
        role,
        salon: { id: "salon-1", slug: "qa-salon" },
      });
      expect(client.rpc).toHaveBeenCalledWith(
        "load_salon_member_operational_profile",
        { p_salon_id: "salon-1" },
      );
      expect(client.from).not.toHaveBeenCalled();
    },
  );

  it.each(["unauthorized", "forbidden"])(
    "fails closed on %s before any base-table fallback",
    async (code) => {
      const client = {
        from: vi.fn(),
        rpc: vi.fn().mockResolvedValue({
          data: { success: false, code },
          error: null,
        }),
      };

      await expect(
        loadSalonMemberOperationalProfile(client as never, "salon-1"),
      ).resolves.toEqual({ ok: false, code });
      expect(client.from).not.toHaveBeenCalled();
    },
  );

  it("rejects a lower-role owner-settings response", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          success: true,
          code: "loaded",
          role: "receptionist",
          settings: { email: "hidden@example.test" },
        },
        error: null,
      }),
    };
    await expect(
      loadSalonOwnerAdminSettings(client as never, "salon-1"),
    ).resolves.toEqual({ ok: false, code: "invalid_response" });
  });
});
