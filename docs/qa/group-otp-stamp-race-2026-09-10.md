# OTP nhóm — chờ đầy đủ dữ liệu trước khi kết luận test

Ngày: 10/09/2026 America/Vancouver. Nhánh `fix/group-otp-stamp-race-20260910`,
bản nền `93e8be2aa3e8d01ef4fa7582b73adaa843c80558`.

**FIXED_LOCAL / PASS_LOCAL** cho lỗi đồng bộ trong bài kiểm thử OTP nhóm.
Chưa commit/push, chưa chạy CI/Preview của lô này, chưa merge/deploy Production.
Đây là mục P1 độ tin cậy của kiểm thử, tiếp nối bằng chứng booking ở PR #1392;
PR #1393 sửa tổng hợp báo cáo được giữ riêng.

## Lỗi đã tái hiện

`otp-gate.spec.ts` chỉ chờ `verification_method = otp` của người tổ chức rồi
kiểm tra `booking_channel` đúng một lần. Trong ứng dụng, RPC
`finalize_public_booking_profile` có thể ghi OTP trước khi callback `after()`
của `stampGroupBookingIdentity` ghi kênh cho cả nhóm. Vì vậy OTP đã có chưa
chứng minh bước ghi kênh đã xong.

Trên source main chưa sửa, chạy luồng thật bằng Chromium với database mới trên
máy, cố ý trì hoãn đúng PATCH ghi `booking_channel = online` trong 5 giây:

- 00:17:31.884 UTC: PATCH bắt đầu bị giữ.
- 00:17:32.726 và 00:17:32.732: đọc DB thấy đủ hai booking; người tổ chức có OTP
  và session, thành viên không có OTP; kênh của cả hai vẫn null.
- Giao diện đã báo đặt nhóm thành công, nhưng test thất bại tại dòng 104,
  `rows.every(...booking_channel === online)`, đúng signature lỗi cũ.
- 00:17:36.887: PATCH được thả theo lịch trì hoãn.

Đây là bằng chứng trực tiếp về race trong bài test. Run cũ của PR #1392 không
có snapshot DB cùng thời điểm để xác nhận mọi chi tiết lịch sử; không suy rộng
rằng mọi lỗi ghi kênh hoặc WebKit crash đều do race này.

## Sửa

Chờ **một snapshot đầy đủ** trong cùng giới hạn 15 giây: đúng hai người, đúng
một người tổ chức; cả hai có kênh online; chỉ người tổ chức có OTP và session.
Thành viên phải có verification null và không có OTP session. Snapshot rỗng,
thiếu người hoặc cấp sai bằng chứng xác minh không thể qua test.

Không tăng timeout/retry, không bỏ assertion, không đổi code ứng dụng,
database, quyền, cấu hình workflow hoặc provider. Bộ gây trễ/lỗi chỉ nằm trong
artifact local, bị ghim vào `http://127.0.0.1:55421`, không được đưa vào app/PR.

## Kết quả

| Kiểm tra | Kết quả |
| --- | --- |
| Bản cũ + giữ PATCH 5 giây, Chromium | FAIL đúng lỗi kênh null; đã lưu trace/ảnh/DB snapshot |
| Bản sửa + cùng độ trễ, Chromium và WebKit, mỗi loại lặp 3 lần | 6/6 PASS; retries=0 |
| Ngăn hẳn PATCH ghi kênh, cả hai trình duyệt | 2/2 báo FAIL đúng sau 15 giây; kiểm tra âm đạt yêu cầu |
| Không gây lỗi: nhóm có OTP và nhóm không OTP, cả hai trình duyệt | 4/4 PASS |
| Lint file đổi, TypeScript sau sửa, diff check | PASS |
| Build ứng dụng bằng Webpack/Node 20 trước sửa test | PASS; source ứng dụng không thay đổi |
| Schema parity trên database local mới | PASS theo contract trong repo; không phải xác minh Production hiện tại |

Trong 6 lượt gây trễ, ghi nhận 42 snapshot OTP đã có nhưng kênh chưa có, sau đó
6 snapshot đầy đủ. Khi ngăn hẳn ghi kênh, test vẫn thất bại dù OTP và giao diện
thành công đã có; bản sửa không biến lỗi mất dữ liệu thành PASS.

Một lần thiết lập ban đầu dùng `next start` bị chặn OTP giả theo đúng guard
production-runtime (`sms_suppressed`); chưa tới bước kiểm tra kênh. Đã giữ bằng
chứng riêng và chuyển sang `next dev --webpack`, môi trường local được hỗ trợ.
Không giả danh GitHub/Vercel, không gỡ guard, không gửi SMS thật. Các lượt browser
trên đây là local development với DB thật dùng một lần, không phải CI/Preview.

Ảnh đại diện đã xem: trang xác nhận nhóm trên desktop và trạng thái OTP trên
mobile. Kiểm tra xác nhận thành công và dữ liệu được thực hiện bằng assertions;
không coi ảnh này là chứng nhận toàn bộ màu sắc/form hoặc 784 chức năng.

## Dọn dữ liệu và bằng chứng

Stack riêng: `nailiq-group-otp-stamp-20260910`, API 55421, Postgres 55422,
ứng dụng 3137. Chỉ có salon và khách giả; không truy cập tenant Hi-Lite.
Sau sweep: 0 salon, 0 booking, 0 auth user; còn 2 client profile giả thuộc
fixture trước khi hủy **toàn bộ database và volumes** bằng `--no-backup`.
Trạng thái hủy cuối cùng lưu trong checkpoint ngoài repo.

Artifact: `/Users/huytran/nailiq-audit-results-20260907/group-otp-stamp-race/`.
Gồm `historical-failure.json`, `baseline-delay-dev`, `fixed-delay`, `fixed-drop`,
`normal-control`, các `*-events.jsonl`, `build.log`, `lint.log`, `typecheck.log`,
`cleanup-counts.json`, `stack-stop.log` và `checkpoint.json`. Trace/log chỉ dùng
local vì có dữ liệu fixture và token tạm; không đưa nguyên bộ lên PR.

Bước tiếp theo: duyệt riêng commit/push hai file của lô này và mở PR chạy
CI/Preview. Không kèm merge/deploy; không kết luận WebKit crash đã được sửa.
