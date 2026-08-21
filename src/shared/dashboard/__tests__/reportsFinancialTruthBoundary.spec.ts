import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { userEn } from "@/shared/i18n/user/en";
import { userVi } from "@/shared/i18n/user/vi";

describe("advanced report financial truth boundary", () => {
  it("labels the current metric as an estimate in both supported languages", () => {
    const en = userEn.receptionist.reports;
    const vi = userVi.receptionist.reports;

    expect(en.kpis.totalRevenue).toBe("Estimated completed service value");
    expect(en.tables.revenueCol).toBe("Estimated value");
    expect(en.estimatedValueNotice).toContain("not collected-payment");

    expect(vi.kpis.totalRevenue).toBe("Giá trị dịch vụ hoàn tất ước tính");
    expect(vi.tables.revenueCol).toBe("Giá trị ước tính");
    expect(vi.estimatedValueNotice).toContain("không phải tổng tiền đã thu");
  });

  it("renders the disclosure beside the current operational report", () => {
    const panel = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/ReportsPanel.tsx"),
      "utf8",
    );
    expect(panel).toContain('data-testid="reports-estimated-value-notice"');
    expect(panel).toContain("messages.estimatedValueNotice");
  });
});
