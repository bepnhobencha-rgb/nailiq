import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  language: "en", refresh: vi.fn(), confirm: vi.fn(), waive: vi.fn(), load: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }), notFound: mocks.notFound }));
vi.mock("@/shared/lib/useUserLanguage", () => ({ useUserLanguage: () => ({ language: mocks.language }) }));
vi.mock("@/shared/noshow/cancellationFeeEmailActions", () => ({
  confirmCancellationFeeFromEmail: mocks.confirm,
  waiveCancellationFeeFromEmail: mocks.waive,
  loadCancellationFeeEmailReview: mocks.load,
}));

import { CancellationFeeAction } from "../CancellationFeeAction";
import CancellationFeePage from "@/app/dashboard/[slug]/cancellation-fee/[bookingId]/page";

type Data = Parameters<typeof CancellationFeeAction>[0]["data"];
const review: Data["reviews"][number] = {
  reviewId: "review-synthetic", reviewKind: "group", amountCents: 2500, currency: "CAD",
  cardBrand: "VISA", cardLast4: "1111", state: "pending_review", paymentStatus: "not_authorized",
  consentPolicyVersion: "synthetic-policy-v1",
};
const data: Data = {
  ok: true, salonId: "salon-synthetic", salonName: "QA Salon", timezone: "America/Vancouver",
  bookingId: "booking-synthetic", clientName: "QA Customer", serviceName: "QA Service",
  startTimeUtc: "2026-09-26T19:00:00Z", reviews: [review],
};
function render(overrides: Partial<typeof review> = {}) {
  return renderToStaticMarkup(createElement(CancellationFeeAction, { slug: "qa-salon", data: { ...data, reviews: [{ ...review, ...overrides }] } }));
}

beforeEach(() => { vi.clearAllMocks(); mocks.language = "en"; });
describe("focused cancellation email fee review", () => {
  it("opens on the exact booking in salon time with explicit approval amount and masked card, without a payment", () => {
    const html = render();
    expect(html).toContain("QA Customer");
    expect(html).toContain("QA Service");
    expect(html).toContain("12:00 PM");
    expect(html).toContain("America/Vancouver");
    expect(html).toMatch(/Approve and collect CAD\s*25.00/);
    expect(html).toContain("Organizer card: VISA •••• 1111");
    expect(html).toContain("Payment requires your confirmation");
    expect(html).toContain("Waive cancellation fee");
    expect(mocks.waive).not.toHaveBeenCalled();
    expect(html).not.toContain('role="dialog"');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("labels already approved fees separately", () => {
    const html = render({ state: "approved_charge", paymentStatus: "dispatch_blocked", reviewKind: "late" });
    expect(html).toMatch(/Collect CAD\s*25.00/);
    expect(html).not.toContain("Approve and collect");
    expect(html).toContain("Approved — not collected");
    expect(html).not.toContain("Waive cancellation fee");
    expect(html).toContain("Saved card");
  });
  it.each(["unknown", "pending_provider", "dispatching"])("blocks another charge while payment is %s", (paymentStatus) => {
    const html = render({ state: "approved_charge", paymentStatus });
    expect(html).not.toMatch(/(?:Approve and collect|Collect CAD)/);
    expect(html).toContain("Reconciling — do not retry");
    expect(html).not.toContain("Waive cancellation fee");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it.each([
    ["approved_charge", "succeeded", "Collected — receipt recorded"],
    ["approved_charge", "failed", "Collection failed"],
    ["waived", "not_authorized", "Waived — no charge"],
    ["not_applicable", "not_authorized", "Fee not applicable"],
    ["invalidated", "not_authorized", "Fee not applicable"],
  ])("shows truthful terminal state %s/%s with no charge action", (state, paymentStatus, label) => {
    const html = render({ state, paymentStatus });
    expect(html).toContain(label);
    expect(html).not.toContain("Waive cancellation fee");
    expect(html).not.toMatch(/(?:Approve and collect|Collect CAD)/);
  });
  it.each([
    { cardBrand: "" }, { cardLast4: "" }, { cardLast4: "123" }, { amountCents: 0 },
    { amountCents: -100 }, { currency: "INVALID" }, { consentPolicyVersion: "" }, { state: "future_unknown_state" },
  ])("fails closed when material is incomplete: %j", (overrides) => {
    expect(render(overrides)).not.toMatch(/(?:Approve and collect|Collect CAD)/);
  });
  it("shows the no-fee state without implying an automatic charge", () => {
    const html = renderToStaticMarkup(createElement(CancellationFeeAction, { slug: "qa-salon", data: { ...data, reviews: [] } }));
    expect(html).toContain("No fee is ready for collection");
    expect(html).toContain('href="/dashboard/qa-salon/no-show-protection"');
    expect(html).not.toContain("Approve and collect");
  });
  it("has Vietnamese parity including amount, saved-card meaning, and explicit confirmation", () => {
    mocks.language = "vi";
    const html = render();
    expect(html).toContain("Xử lý phí hủy lịch");
    expect(html).toContain("Duyệt và thu");
    expect(html).toContain("Miễn phí hủy");
    expect(html).toContain("25,00");
    expect(html).toContain("CAD");
    expect(html).toContain("Thẻ người tổ chức");
    expect(html).toContain("Chỉ thu khi bạn xác nhận");
    expect(html).toContain("Cập nhật trạng thái");
  });
});

describe("cancellation email route read boundary", () => {
  const params = Promise.resolve({ slug: "qa-salon", bookingId: "booking-synthetic" });
  it("loads only the addressed booking and never confirms on GET", async () => {
    mocks.load.mockResolvedValue(data);
    const page = await CancellationFeePage({ params });
    expect(mocks.load).toHaveBeenCalledWith("qa-salon", "booking-synthetic");
    expect(renderToStaticMarkup(page)).toContain("QA Customer");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it.each(["unauthorized", "not_found"])("does not reveal booking data for %s", async (error) => {
    mocks.load.mockResolvedValue({ ok: false, error });
    await expect(CancellationFeePage({ params })).rejects.toThrow("NOT_FOUND");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("renders an honest unavailable state, never a no-fee or paid result", async () => {
    mocks.load.mockResolvedValue({ ok: false, error: "unavailable" });
    const html = renderToStaticMarkup(await CancellationFeePage({ params }));
    expect(html).toContain("Unable to load fee review");
    expect(html).not.toContain("QA Customer");
    expect(html).not.toContain("Collected");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
