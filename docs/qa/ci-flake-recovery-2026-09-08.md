# CI flaky follow-up — 2026-09-08

Base: `d585c4ee2134f5c2dfb62c51fbe02bb27853b117` (PR #1363 đã merge).
Phạm vi: ba ca flaky của main E2E run `34311310154`. Chỉ sửa test chờ layout; không thay đổi mã sản phẩm, CSS, dữ liệu khách hàng hoặc cấu hình Production.

## 1. Header hàng chờ — FIXED_LOCAL, CI chưa chạy bản sửa

`e2e/receptionist-center/queue.spec.ts` chờ cố định 350ms rồi đo padding và vị trí nút. CI WebKit từng đo padding 79.726px, dưới ngưỡng 320px; retry đạt. Class mở panel không bảo đảm animation/layout đã hoàn tất.

Thay khoảng chờ cố định bằng `expect(...).toPass({ timeout: 5_000 })`, kiểm tra đồng thời panel vẫn mở, hai phần tử đo được, padding >= 320px và cạnh phải nút không vượt cạnh trái panel (+1px tolerance có sẵn). Không đổi timeout ca test hoặc số retry của runner.

Bằng chứng kiểm soát:

- Code test cũ ở tốc độ bình thường: 6/6 đạt (ba lần mỗi browser); chưa tái hiện đúng sự kiện CI tự nhiên.
- Chỉ trong harness, tăng transition header thành 1200ms linear: test cũ 0/2 đạt, cùng loại assertion padding (219.598px / 137.867px); bản sửa 2/2 đạt.
- Negative control chỉ trong harness: ép padding về 0; bản sửa từ chối đúng cả 2/2 lượt. Không làm yếu assertion để đổi lỗi thành PASS.
- Tất cả CSS tiêm thử nghiệm đã gỡ khỏi diff cuối. Sự kiện gây chậm paint chính xác trên GitHub runner vẫn chưa được tái hiện độc lập; thí nghiệm chứng minh điểm yếu của fixed wait và khả năng chờ layout đúng.

## 2. Hai ca group booking — NOT_PROVEN, không sửa phỏng đoán

- `guest-placeholder.spec.ts`: `group booking succeeds when member names are not manually edited`.
- `organizer-pre-claim.spec.ts`: `organizer's own slot is pre-claimed; the other guest's is open`.

CI ban đầu timeout 90s ở teardown context. Trace ghi nhận cả 6 và 3 assertion tương ứng đã hoàn tất không lỗi trước teardown; retry đạt. Có thêm timeout fixture ghi trace, chưa đủ chứng minh nguyên nhân browser/runner hay lỗi booking.

Giữ nguyên hai file test và mã booking. Sau khi sửa cấu hình harness local, hai ca probe Linux đạt 2/2; toàn bộ hai file trên Linux Chromium/WebKit, lặp ba lần, đạt 42/42. Đối chiếu cuối trên macOS cũng đạt, không tái hiện timeout đóng context. Không tăng timeout, bỏ trace/video, skip hoặc đổi retries để che lỗi.

## 3. Verification cuối

- Linux group suites: **42/42** đạt (7 ca × 2 browsers × 3 lần).
- Linux toàn bộ queue suite: **16/16** đạt.
- macOS ba ca từng flaky, hai browsers, lặp ba lần: **18/18** đạt.
- Tổng **76 lượt bình thường của 30 ca phân biệt** đều đạt; 0 skip, 0 test retry, 0 lỗi cấp report. Không cộng các negative control vào tổng này.
- Build production local, schema parity, typecheck, focused lint, diff check PASS. Không chạy lại full unit suite vì chỉ đổi cách chờ trong một E2E test và tài liệu.
- App chạy Next production build trên macOS/Node 20; browser runner Linux dùng image Playwright 1.59.1, ARM64/Node 24.14.1. Browser và tests Linux chạy qua TCP proxy tới đúng app/database local; đây không phải môi trường GitHub Linux x64/Node 20 hoàn toàn tương đương.
- Global production guard và outbound SMS/call/email suppression bật; chỉ database dùng một lần trên loopback, không credentials/provider/tenant thật.

## 4. Lịch sử harness phải giữ

Lần chạy Linux đầu bị dừng sau khi phát hiện quote API trả 403, khiến nút xác nhận bị khóa. Runner thiếu `NEXT_PUBLIC_APP_URL` trong khi server bind `0.0.0.0`; khác CI dùng `next start` không chỉ định hostname. Khai báo đúng URL local, build/restart lại rồi hai ca probe đạt. Không thay đổi origin boundary của sản phẩm. Đây không phải hai timeout teardown cần điều tra.

Artifacts riêng: `/Users/huytran/nailiq-audit-results-20260907/ci-flake-recovery/` gồm báo cáo JSON, traces, controls trước/sau, log build/schema và cleanup. CI/Preview của bản sửa test mới chưa chạy; chưa commit/push/merge/deploy lô này. Không dùng số lượt test để khẳng định 784 chức năng đã hoàn thành.

Cleanup cuối: server port 3109 đã dừng; container và volume của `nailiq-ci-flakes-20260908` đã xóa; port 54321 không listener; Colima được trả về trạng thái dừng ban đầu.
