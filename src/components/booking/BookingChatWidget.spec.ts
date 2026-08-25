import { describe, expect, it } from "vitest";
import { bookingChatDisclaimer } from "./BookingChatWidget";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";

describe("bookingChatDisclaimer", () => {
  it("keeps the answer-only guidance for salons without the pilot flag", () => {
    expect(bookingChatDisclaimer(bookingEn, false)).toBe(
      bookingEn.chat.disclaimer,
    );
  });

  it("describes the reviewed booking flow when tools are enabled", () => {
    expect(bookingChatDisclaimer(bookingEn, true)).toBe(
      bookingEn.chat.transactionalDisclaimer,
    );
    expect(bookingChatDisclaimer(bookingVi, true)).toBe(
      bookingVi.chat.transactionalDisclaimer,
    );
  });
});
