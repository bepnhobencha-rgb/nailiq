# CI không bỏ sót kết quả Playwright bổ sung

Ngày: 2026-09-10 America/Vancouver. Nhánh: `fix/ci-report-completeness-20260910`.
Bản nền: `93e8be2aa3e8d01ef4fa7582b73adaa843c80558`.

## Kết luận

**FIXED_LOCAL / PASS_LOCAL** cho lỗi tổng hợp báo cáo. Chưa commit, push,
CI/Preview hoặc triển khai bản sửa này. Không phải bản sửa lỗi crash WebKit
hay lỗi dấu kênh đặt lịch nhóm; hai nguyên nhân đó vẫn **NOT_PROVEN**.

Đây là phần kiểm chứng CI của các lỗi booking đã ghi nhận trong PR #1392,
thuộc mục P1 build/deploy đáng tin cậy. PR ngôn ngữ #1392 giữ nguyên.

## Lỗi và bằng chứng trước sửa

[E2E run 34538803828](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/34538803828),
attempt 1, có một ca Complete booking end-to-end thất bại trong
`booking-submit-webkit-results.json` và một ca OTP nhóm flaky trong
`results.json`. Kết quả gốc đã được lưu trước khi rerun.

Chạy mã báo cáo của bản nền trên đúng artifact này:

- Tóm tắt shard chỉ đọc `results.json`, ghi 174 passed, 0 failed, 0 flaky và
  “All executed specs passed.” Ca flaky bị gộp vào pass theo attempt cuối.
- AI triage chỉ đọc file tên `results.json` của từng shard nên ghi
  “No failed tests in any shard report.” Nó không đọc JSON bổ sung WebKit.
- Workflow tổng vẫn FAIL đúng. Lỗi nằm ở bằng chứng/tóm tắt, không phải ở
  điều kiện chặn merge của E2E.

## Sửa

Hai đầu ra dùng chung bộ đọc không có dependency ngoài Node: summary đọc
report tại một artifact; triage đọc các thư mục `playwright-report-shard-N`.
Đọc `results.json` và `*-results.json` tại gốc artifact, bỏ qua thư mục HTML,
trace/data, JSON không phải report và symlink để không đếm bản sao.

Phân loại theo outcome của Playwright: đạt kỳ vọng, lỗi, flaky, skipped,
interrupted hoặc chưa rõ. Giữ thông báo lỗi của attempt thất bại khi test
flaky; tôn trọng expected failure thay vì coi mọi attempt failed là lỗi.
Lỗi cấp runner, thiếu/hỏng report và cấu trúc không hợp lệ được nêu rõ.
Không coi thiếu kết quả, toàn skip hoặc interrupted là đã đạt. Chi tiết giới
hạn 10 mục mỗi loại nhưng tổng số vẫn đầy đủ. Lỗi parse không in payload.

Workflow gọi bộ đọc đã được test thay vì đoạn tổng hợp nhúng. Prompt/nhãn
triage mô tả đúng cả lỗi, flaky và dữ liệu thiếu. Mọi cấu hình workflow khác,
bao gồm test, retry, timeout, quyền, provider command, cleanup và release gate,
không thay đổi.

## Kiểm chứng

| Kiểm tra | Kết quả |
| --- | --- |
| 15 ca hồi quy bộ đọc, Node 24.15.0 | 15/15 PASS |
| Cùng 15 ca trên Node 20.20.2 | 15/15 PASS; không cộng thành 30 chức năng |
| Toàn bộ unit suite | 4.757 PASS, 1 skip có sẵn; 750 file PASS, 1 file skip |
| ESLint các file đổi | PASS, không warning/error |
| YAML parse, cú pháp shell và Node | PASS; chỉ kiểm tra cú pháp, không gọi provider |
| So sánh cấu hình workflow ngoài nội dung bước triage | Khớp bản nền |
| Replay attempt 1, 10 JSON thuộc 5 shard | 676 đạt, 1 lỗi, 1 flaky, 16 skip |
| Replay attempt 2 của shard non-RC, 6 JSON | 218 đạt, 0 lỗi, 0 flaky, 2 skip |
| Đối chiếu số đếm với `stats` gốc của từng report | Khớp cả hai lần, Node 20 |
| `git diff --check` | PASS |

Các lượt Guided Setup/Reports hydration chỉ có log không nằm trong tổng JSON;
16 visual và 8 smoke cũng không được tự cộng vào bộ đọc này. Số đếm chỉ bao
phủ các report đã đọc, gồm các lượt lặp, không xác nhận toàn workflow hoặc
784 chức năng. Artifact hoàn toàn vắng mặt chưa thể được suy ra từ thư mục
tải xuống; vì vậy đầu ra không khẳng định đã có toàn bộ báo cáo.

Không chạy lại browser/build ứng dụng vì thay đổi chỉ nằm ở công cụ đọc báo
cáo và kiểm tra của nó; đã replay cả bộ lỗi và bộ đạt thật, cùng full unit.
Không mở database, gọi provider, gửi comment/email, đổi dữ liệu thật hoặc
đụng worktree đang có thay đổi khác. Cảnh báo cấu hình Vite có sẵn được giữ
nguyên, không suppress.

## Bằng chứng và bước tiếp theo

Artifacts: `/Users/huytran/nailiq-audit-results-20260907/ci-report-completeness/`.
Gồm `baseline-summary.md`, `baseline-triage.txt`, `fixed-summary-attempt1.md`,
`fixed-triage-attempt1.txt`, `fixed-summary-attempt2.md`,
`actual-artifact-replay.json`, `unit-focused.log`, `unit-node20.log`,
`unit-full.log`, `lint.log`, `workflow-check.json` và bản diff cuối.

Bước công bố: duyệt riêng lô công cụ CI này, commit/push nhánh hiện tại và mở
PR. Không gộp vào PR sửa ngôn ngữ; chưa có phê duyệt merge hoặc Production.
