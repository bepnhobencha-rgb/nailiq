/**
 * Customer-facing BOOKING TERMS — the legal wrapper a client agrees to when
 * booking with a salon. Platform-provided template (salon name inserted); NOT
 * salon-editable (legal boilerplate, reviewed once for all salons). The salon's
 * commercial cancellation/no-show/deposit specifics live in the separate,
 * salon-editable Cancellation Policy and are referenced here.
 *
 * ⚠️ TEMPLATE, not legal advice — a lawyer should review for CA (US) + BC (Canada).
 */

import { resolveVertical } from "@/shared/verticals/registry";

export type TermsLang = "en" | "vi";

export function bookingTerms(lang: TermsLang, salonName: string, verticalSlug?: string | null): string {
  const s = salonName || (lang === "vi" ? "tiệm" : "the salon");
  const v = resolveVertical(verticalSlug);
  const risk = v.legalServiceRisk[lang]; // vertical-specific (nail vs head spa…)
  if (lang === "vi") {
    return [
      `Điều khoản đặt lịch — ${s}`,
      ``,
      `1. Hợp đồng với tiệm: Khi bạn đặt lịch, bạn giao kết trực tiếp với ${s} cho dịch vụ và thanh toán. NailIQ chỉ cung cấp phần mềm đặt lịch và không phải là một bên trong giao dịch này.`,
      `2. Thông tin chính xác: Bạn cung cấp tên, số điện thoại và (tuỳ chọn) email chính xác để xác nhận và liên hệ về lịch hẹn.`,
      `3. Rủi ro dịch vụ: ${risk} Bạn hiểu và chấp nhận rủi ro thông thường của dịch vụ đã chọn.`,
      `4. Huỷ / vắng mặt / đặt cọc: Áp dụng theo Chính sách huỷ của ${s} (xem link bên dưới), gồm phí vắng mặt và đặt cọc nếu có.`,
      `5. Lưu thẻ & thanh toán: Nếu bạn cho phép lưu thẻ, bạn cho phép ${s} chỉ trừ phí vắng mặt theo chính sách khi bạn không đến. Thanh toán do Square/Stripe xử lý; ${s} là đơn vị thu tiền.`,
      `6. Liên lạc: Bằng việc đặt lịch, bạn đồng ý nhận tin nhắn/email về lịch hẹn. Bạn có thể ngừng bất cứ lúc nào (nhắn STOP / bấm Unsubscribe).`,
      `7. Giới hạn trách nhiệm: Trong phạm vi pháp luật cho phép, trách nhiệm của ${s} giới hạn ở giá trị dịch vụ liên quan. NailIQ không chịu trách nhiệm về dịch vụ do ${s} cung cấp.`,
      `8. Liên hệ & khiếu nại: Vui lòng liên hệ trực tiếp ${s}.`,
      ``,
      `[Template — tiệm và luật sư vui lòng rà soát cho từng vùng.]`,
    ].join("\n");
  }
  return [
    `Booking Terms — ${s}`,
    ``,
    `1. Agreement with the salon: When you book, you enter into an agreement directly with ${s} for the service and payment. NailIQ only provides the booking software and is not a party to that transaction.`,
    `2. Accurate information: You provide an accurate name, phone, and (optional) email so your appointment can be confirmed and managed.`,
    `3. Service risks: ${risk} You understand and accept the ordinary risks of the service you choose.`,
    `4. Cancellation / no-show / deposit: Governed by ${s}'s Cancellation Policy (linked below), including any no-show fee and deposit.`,
    `5. Card on file & payment: If you allow your card to be saved, you authorize ${s} to charge only the no-show fee per the policy if you don't show. Payments are processed by Square/Stripe; ${s} is the merchant.`,
    `6. Communications: By booking, you agree to receive messages/emails about your appointment. You can opt out anytime (reply STOP / click Unsubscribe).`,
    `7. Limitation of liability: To the extent permitted by law, ${s}'s liability is limited to the value of the relevant service. NailIQ is not responsible for services provided by ${s}.`,
    `8. Contact & complaints: Please contact ${s} directly.`,
    ``,
    `[Template — salon and lawyer should review for each jurisdiction.]`,
  ].join("\n");
}
