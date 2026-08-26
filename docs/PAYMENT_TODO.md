# Payment — việc triển khai sau (ghi nhớ 2026-06-14)

Verified từ code thật. Làm theo thứ tự ưu tiên:

> Cập nhật phạm vi V1 ngày 2026-08-24: Square tiếp tục vận hành tiền, Loyalty
> và Gift Card trực tiếp. Gift Card sync/issuance trong NailIQ chuyển Phase 2,
> không phải blocker V1 và không được quảng cáo là đã có.

## 1. Gift Card thu tiền thật (PHASE 2)
- Hiện trạng: route public và action phát hành local cũ đã bị retire vĩnh viễn; trang public trả 404 và API trả 503. Không được bật lại bằng flag hoặc tạo local voucher value.
- Quyết định sản phẩm: Square là nguồn sự thật duy nhất cho funds/state/balance của Gift Card.
- Cần: tạo flow mới, tách biệt, dùng durable Square create → completed payment → activation receipt chain rồi mới mở UI. Không phát hành nếu thiếu exact paid receipt; không tự đặt ngày hết hạn.

## 2. Hợp nhất luật deposit về một nguồn
- Hiện trạng: đường Stripe (`api/booking/deposit-intent`) dùng rule engine `shared/noshow/evaluateDeposit.ts` (VIP miễn, owner override, lịch sử no-show 50%, high-value 30%, new 20%).
- Đường Square (`integrations/square/deposits.ts → loadPolicy`) đọc thẳng `square_integrations.deposit_percent/threshold`, KHÔNG gọi `evaluateDeposit`.
- Cần: Square cũng đi qua `evaluateDeposit` → một nguồn sự thật, Hilite hết "luật hạng hai".

## 3. Đồng bộ số tiền cọc hiển thị vs charge thật
- Số `determine_booking_verification` (RPC) báo cho khách phải = số Square/Stripe thật sự trừ.

## Sau cùng (refactor, không gấp)
- Gom phần deposit/refund phù hợp về một `PaymentProvider` interface chung; Gift Card vẫn Square-only theo quyết định sản phẩm.
