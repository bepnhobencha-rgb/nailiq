# Square saved-card fee — QA Sandbox thật, 2026-09-25

**PASS ở lớp adapter/Square Sandbox; chưa chứng nhận Production hoặc toàn bộ luồng Owner/booking.** Dùng code local `src/shared/integrations/square/client.ts` sau bản sửa kiểm tra receipt. Bằng chứng đã lọc dữ liệu nằm trong `square-saved-card-fee-sandbox-2026-09-25.evidence.json`.

| Kịch bản | Kết quả thực tế |
|---|---|
| Đối chiếu token/application/merchant, location CAD active, không có webhook enabled | PASS, API Sandbox thật |
| Tạo customer synthetic và lưu thẻ từ nonce Sandbox cố định; thu CAD 1.00 | PASS, receipt đúng amount/currency/location/customer/reference |
| Gửi lại cùng idempotency key | PASS, trả cùng payment receipt |
| Thẻ Sandbox từ chối | PASS, Square trả `GENERIC_DECLINE` |
| Giả lập mất phản hồi sau CreatePayment thành công | PASS, chỉ một payment POST cho operation này |
| Phục hồi bằng read-only ListPayments theo reference | PASS, tìm đúng một COMPLETED receipt, fingerprint khớp receipt đã mất |
| Hai request đồng thời, cùng idempotency key | PASS, hai response có cùng payment ID, đối soát đúng một payment |

Run đầu dừng tại lần đối soát tức thời; không chạy lại mutation cho operation đó. Một script chỉ đọc đã phục hồi đúng receipt. Run race đầu cũng dừng tại đối soát tức thời và được phục hồi chỉ đọc. Cả hai kết quả chưa hoàn tất ban đầu được giữ trong evidence, không đổi thành PASS của toàn run.

Run race cuối ghi nhận nguyên nhân cụ thể: CreatePayment trả `COMPLETED`, nhưng ListPayments tức thời trả `APPROVED`; khoảng 1,2 giây sau, lần đọc tiếp theo trả `COMPLETED`. Đây là độ trễ cập nhật phía Square. Giữ pending/unknown và đối soát tiếp; không coi lần đọc đầu là bằng chứng để charge lại.

Tổng mutation trong các lần chạy: 1 customer synthetic, 1 card synthetic, 8 payment POST; tương ứng 4 payment Sandbox thành công riêng biệt CAD 1.00, một request decline và các request trùng idempotency. Không charge tiền thật, không Production, không ghi database, không tạo/hủy booking, không gọi API gửi SMS/email/call. Customer không có phone/email. Webhook subscriptions được kiểm tra không enabled; trạng thái tắt thông báo tự phát tới merchant **chưa được chứng minh**, không ghi nhận là OFF. Không xóa/refund fixture; giữ journal để điều tra.

## Harness tái sử dụng

`scripts/qa/square-saved-card-fee-sandbox.ts` là harness riêng; guard card-only có sẵn vẫn cấm payment/refund. Bản đóng gói đã lint và kiểm tra opt-in gate; chưa chạy lại mutation sau khi đóng gói. Các lần test thật phía trên dùng runner giới hạn tương đương, lưu ở thư mục evidence riêng.

Chạy từ repo root bằng `node --conditions=react-server --import ./node_modules/tsx/dist/loader.mjs scripts/qa/square-saved-card-fee-sandbox.ts`, sau khi nạp riêng các biến sau vào process:

- `NAILIQ_FEE_SANDBOX_QA=1`, `NAILIQ_QA_SQUARE_ENVIRONMENT=sandbox`.
- `DISABLE_OUTBOUND_SMS=1`, `DISABLE_OUTBOUND_EMAIL=1`, `DISABLE_OUTBOUND_CALLS=1`.
- `NAILIQ_QA_SQUARE_CREDENTIALS_FILE`: đường dẫn tuyệt đối tới JSON **ngoài repository**, quyền 0600, gồm các key `NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID`, `NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID`, `NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID`, `NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN`, `NAILIQ_QA_SQUARE_SANDBOX_WEBHOOK_ACCESS_TOKEN`.
- `NAILIQ_QA_FEE_EVIDENCE_DIRECTORY`: thư mục tuyệt đối đã tồn tại, ngoài repository.
- Mặc định yêu cầu `NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED=1` với bằng chứng tắt thông báo riêng. Chỉ dùng `NAILIQ_QA_SQUARE_NOTIFICATION_MODE=test_notifications_authorized` khi có phê duyệt rõ cho thông báo Sandbox có thể phát sinh. Flag này không chứng minh thông báo OFF.

Không dùng `.env.local`, không đưa token vào terminal/chat. Harness pin host Sandbox, xác minh cặp token/account, giới hạn 1 customer + 1 card + 6 payment POST, amount đúng CAD 1.00, customer không contact, không charge/refund ngoài route cho phép. Journal mở độc quyền 0600 trước mutation; báo cáo chỉ có metadata/fingerprint an toàn. Khi lỗi, giữ journal và đối soát reference cũ; **không tự chạy lại để tạo một run mới**. Sau response loss chỉ retry đọc tối đa 5 lần; không phát lại payment.

## Còn cần chứng nhận

- Owner Charge/Waive, quyền salon và consent qua giao diện thật.
- Database ledger/retry/webhook cùng approval material thật của ứng dụng.
- Preview và phê duyệt bật Production.
- Helper `findExactSquarePaymentByReference` hiện chưa có tham số customer binding; cần đánh giá caller trước khi dùng cho fee recovery ngoài harness này.

Tài liệu Square: [CreatePayment](https://developer.squareup.com/reference/square/payments/create-payment), [Sandbox payments](https://developer.squareup.com/docs/devtools/sandbox/payments), [Card-on-file decline fixtures](https://developer.squareup.com/docs/cards-api/manage-card-on-file-declines).
