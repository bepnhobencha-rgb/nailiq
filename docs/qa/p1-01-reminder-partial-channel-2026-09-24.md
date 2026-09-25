# P1-01 — Reminder partial-channel recovery

Phạm vi: local-only, 24/09/2026 Vancouver. Base HEAD
`733d44e0f9256f343b181dc8a5f66434dfd02ac7`, branch
`fix/waitlist-invite-identity-20260924`. Không suy luận bản Production đang lỗi
từ lần kiểm code local này; chưa xác minh deployment hiện hành trong lượt này.

## Lỗi tái hiện và sửa local

Handler dùng một cờ `anySuccess` để ghi marker chung cho lượt nhắc. Khi email lỗi
nhưng SMS thành công (hoặc ngược lại), marker vẫn được ghi; truy vấn lần sau lọc
marker NULL nên không chọn lại booking để thử kênh còn lỗi.

Test runtime gọi trực tiếp GET, mock database/provider, giữ classifier thật và
chặn fetch. Trước sửa: 3 FAIL / 2 PASS, gồm email 429, SMS 429 và suppression
lookup unavailable. Cả ba ca ghi marker không đúng; không phải timeout/flake.

Sửa `src/app/api/cron/reminders/route.ts`: chỉ ghi marker khi tất cả kênh được
chọn đã sent/suppressed. Claim unavailable, failed, sending, unknown không bị
che bởi thành công của kênh khác. Claim sent/suppressed được tái sử dụng mà không
gửi lại; marker thiếu có thể phục hồi từ claim đã hoàn tất. Không thay RPC/schema,
quy tắc đồng ý nhận, auth, kill switch hoặc chính sách thời gian.

## Kiểm chứng

```sh
./node_modules/.bin/vitest run src/app/api/cron/reminders/route.runtime.spec.ts src/shared/reminders/__tests__ src/shared/security/__tests__/reminderWorkerFailureBoundary.spec.ts src/shared/security/__tests__/reminderOutboundKillSwitchBoundary.spec.ts src/shared/security/__tests__/reminderEmailEvidenceBoundary.spec.ts
npm run typecheck
./node_modules/.bin/eslint src/app/api/cron/reminders/route.ts src/app/api/cron/reminders/route.runtime.spec.ts
git diff --check
```

- **65 tests / 9 suites PASS**, trong đó 28 runtime tests mới cho cả 24h/3h.
  Có ca hai lượt worker liên tiếp: kênh lỗi gọi hai lần, kênh đã gửi chỉ một lần.
- Typecheck, lint hai file, diff check PASS.
- Build `npm run build -- --webpack` PASS, 61/61 static pages. Môi trường sạch
  như lệnh build trong `p1-01-reminder-boundaries-2026-09-24.md`: credential giả,
  URL loopback cổng 1, SMS/email/call OFF, không dotenv. Còn cảnh báo Edge Runtime
  deprecated và Vite config loader; không thay cấu hình để che cảnh báo.
- Rà soát độc lập không thấy regression cụ thể trong thay đổi marker.

## Giới hạn và bước tiếp theo

- Đây là handler runtime với I/O giả lập, không phải hosted/cron/provider E2E.
- Retry vẫn chỉ được chọn khi booking còn trong cửa sổ ±15 phút hiện có. Lỗi tại
  lần chọn cuối cùng có thể không được gửi lại. Không tự mở rộng cửa sổ hoặc hứa
  đã xử lý outage dài; cần kiểm riêng recovery sau khi rời cửa sổ.
- Không thay nhánh group; chưa kiểm đầy đủ cancellation/reschedule đồng thời
  trong worker. Không gọi endpoint cron thật hoặc gửi tin thật.
- Chưa commit/push, Preview, deploy, migration hoặc thay dữ liệu Production.
- Rollback local: bỏ riêng thay đổi marker trong route và test mới; không đụng
  các tài liệu đang sửa từ lượt trước. Không có rollback database cần thực hiện.

**Kết luận:** lỗi partial-channel đã tái hiện và sửa/test local PASS; P1-01 tổng
thể vẫn NOT COMPLETE. Cần phát hành được duyệt và hosted verification trước khi
gọi đây là bản sửa Live.

## Follow-up: bộ lọc thời gian và giới hạn catch-up

- Thay mock trả dữ liệu theo thứ tự query bằng mock đánh giá các điều kiện thực
  tế handler truyền vào: status IN, start_time GTE/LTE và marker IS NULL.
  Fixture 3h nay có start time đúng cửa sổ 3h, không chỉ ép trả vào query thứ hai.
- Bộ test mở rộng **77 tests / 9 suites PASS**, trong đó 40 runtime cases.
  Hủy, completed, no_show, đổi giờ ra ngoài window và marker đã có đều không
  được chọn. Hai ca catch-up là characterization của hạn chế, KHÔNG phải PASS
  nghiệm thu chức năng phục hồi outage.
- Tái hiện cả 24h/3h: lịch ở tâm window lúc 00:00Z; lần 00:15Z gặp lỗi email
  429, SMS thành công, marker vẫn NULL theo fix. Lần 00:30Z không còn trong window,
  không claim/retry email; handler trả 200, sent=0/errors=0. Không có truy vấn
  failed-claim recovery trong handler đã đọc. Đây là bằng chứng local với DB
  giả lập bộ lọc, không phải lỗi đã quan sát trên Production.
- Chưa sửa thời hạn gửi hoặc nội dung nhắc: mở rộng catch-up làm thay đổi thời
  điểm khách nhận và có thể khiến câu “in 3 hours” sai. Đề xuất cần chủ sản phẩm
  duyệt: retry chỉ failed chắc chắn chưa gửi, tối đa 3 attempts theo ledger sẵn,
  giới hạn trễ cấu hình (đề xuất ban đầu 60 phút), vẫn trước giờ hẹn, kiểm lại
  trạng thái/occurrence/consent; unknown không tự gửi lại; copy hiển thị giờ hẹn
  thật thay vì hứa còn đúng 3 giờ. Hết hạn phải có báo cáo missed, không coi sent.
- Không nới window, không sửa schema/Production, không gửi bù hoặc gọi provider.
