# Payment — việc triển khai sau (ghi nhớ 2026-06-14)

Verified từ code thật. Làm theo thứ tự ưu tiên:

## 1. Gift card thu tiền thật (GẤP)
- Hiện trạng: `api/gift-card/purchase` + `shared/loyalty/giftCardActions.ts` chỉ sinh mã voucher trong DB (`kind:"gift", amount_off_cents`), KHÔNG charge người mua qua provider nào.
- Cần: chèn bước thanh toán (Square cho salon Square / Stripe cho salon Stripe) TRƯỚC khi tạo mã.

## 2. Hợp nhất luật deposit về một nguồn
- Hiện trạng: đường Stripe (`api/booking/deposit-intent`) dùng rule engine `shared/noshow/evaluateDeposit.ts` (VIP miễn, owner override, lịch sử no-show 50%, high-value 30%, new 20%).
- Đường Square (`integrations/square/deposits.ts → loadPolicy`) đọc thẳng `square_integrations.deposit_percent/threshold`, KHÔNG gọi `evaluateDeposit`.
- Cần: Square cũng đi qua `evaluateDeposit` → một nguồn sự thật, Hilite hết "luật hạng hai".

## 3. Đồng bộ số tiền cọc hiển thị vs charge thật
- Số `determine_booking_verification` (RPC) báo cho khách phải = số Square/Stripe thật sự trừ.

## Sau cùng (refactor, không gấp)
- Gom hai silo Stripe/Square về một `PaymentProvider` interface chung (createDeposit, capture, refund, issueGiftCard, redeemGiftCard, capabilities) + chọn theo salon trong Settings.
