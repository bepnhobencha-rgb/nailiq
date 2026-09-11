# P1 — Kết thúc đúng bản ghi chờ xử lý thẻ

Trạng thái: **LOCAL PASS, chưa phát hành**. Base: `af3271d0e71d4f1000a318d326e6a4000d1ec536` (main sau PR #1395). Nhánh: `fix/card-manual-review-20260910`.

## Phát hiện và nguyên nhân

Sau phát hành #1395, một thao tác lưu thẻ Square ở Production chuyển sang `unknown / manual_review_required` sau ba lần đối soát. Lịch liên quan đã hủy, còn continuation vẫn pending. Đọc lại trạng thái trong lượt này xác nhận chưa thay đổi. Nguyên nhân lần gọi Square đầu tiên và trạng thái thẻ thực tế tại Square vẫn **NOT_PROVEN**; không gọi lại nhà cung cấp hoặc sửa bản ghi thật để thử.

Đã xác minh cấu hình: `BOOKING_CARD_CONTINUATION_RECONCILIATION_ENABLED` không có trong biến Production của project và danh sách biến của deployment đang chạy. Code chỉ chạy continuation worker khi giá trị đúng chuỗi `true`; đây là nguyên nhân continuation không tự được xử lý. Worker đối soát thao tác lưu thẻ riêng đã bật. Đọc tổng hợp tại mốc đến hạn 2026-09-11 02:30 UTC thấy 137 continuation chưa xử lý: 120 gắn với lịch đã hủy/hoàn thành/no-show, 17 gắn với lịch confirmed. Không bật công tắc này trong lượt kiểm tra.

Trước khi đề xuất bật worker, đã tái hiện các nhánh trên database local dùng schema thật. Worker cũ chỉ kết thúc continuation của lịch cancelled; lịch completed/no_show có thể tiếp tục chờ thẻ hoặc bị đưa sang kiểm tra thủ công vì thiếu assessment. Thao tác thẻ đã dừng tự đối soát cũng vẫn bị coi là provider đang xử lý. Bài kiểm tra 12 tình huống trên main thất bại 4 trường hợp.

## Thay đổi

Migration mới chỉ thay định nghĩa `reconcile_due_booking_card_management_continuations(integer)`:

- Continuation của lịch `cancelled`, `completed`, `no_show` hoặc đã xóa mềm kết thúc với `resolved / booking_inactive`.
- Với lịch còn hoạt động, chưa có thẻ đã lưu, nếu thao tác thẻ là `sending/unknown` và `resolution_code=manual_review_required`, continuation chuyển sang `manual_review / reconciliation_exhausted` và dừng lịch chạy lại.
- Các nhánh còn chờ khách, còn có thể đối soát, đã lưu thẻ, thiếu assessment và lịch chạy tương lai giữ hành vi hiện có.

Migration không tự chạy worker hoặc cập nhật hàng dữ liệu cũ. Không đổi công tắc, quyền truy cập, trạng thái booking, phí hoặc bằng chứng ở bảng thao tác thẻ. `resolved / booking_inactive` chỉ kết thúc continuation của lịch đã đóng; không đồng nghĩa thao tác lưu thẻ đã thành công hoặc không còn cần kiểm tra tại Square.

## Kết quả kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| Đối chứng main, 12 tình huống SQL thật | 8 đạt, 4 thất bại đúng nhánh đã nêu |
| Cùng 12 tình huống sau sửa | 12/12 đạt |
| Giới hạn 0, hàng chưa đến hạn, chạy lặp cùng thời điểm | Đạt; không xử lý ngoài phạm vi đến hạn |
| Snapshot booking và thao tác thẻ trước/sau worker | Toàn bộ giữ nguyên |
| Quyền chạy worker | Chỉ service_role; anon/authenticated không có EXECUTE |
| Rehearsal đặt lịch, định giá, idempotency | Đạt |
| Rehearsal capability quản lý lịch/thẻ | Đạt |
| Unit: booking/card/continuation/cron/security | 62/62 đạt, 8 file |
| Production build local, Node 20 + Webpack | Đạt |
| Typecheck | Đạt |
| Kiểm tra lịch sử migration và schema parity local | Đạt |
| Security advisor local, mức error | Không có phát hiện |
| YAML workflow và đăng ký bài rehearsal | Đạt |

Đã thêm bài SQL vào workflow Migration History Rehearsal và bộ lọc đường dẫn để các thay đổi sau này tiếp tục chạy nó. Kết quả CI/Preview của nhánh mới chưa có; chưa commit/push/merge. Đây là kiểm tra database và các lớp gọi liên quan; không tính là chứng nhận lại toàn bộ giao diện, SDK Square thật hoặc 784 chức năng.

Fixture chỉ gồm salon `e2e-card-terminal`, số 555 và dữ liệu giả. Mỗi rehearsal rollback; xác nhận 0 salon, booking, thao tác thẻ, continuation, auth user và client profile trước khi dọn database. Không có request đến Square/Twilio/Resend, thao tác khách thật hoặc thay đổi Production.

## Điều kiện trước Production

PR riêng phải qua CI/Preview và review migration. Việc áp dụng migration và việc bật continuation worker là các bước riêng. Trước khi bật, đọc lại số lượng/phân loại bản ghi đến hạn và xác minh phạm vi tác động; không tự backfill hoặc gọi đối soát Production. Ca thẻ thật vẫn cần đối chiếu kết quả tại Square bằng quyền đọc được phê duyệt.

Bằng chứng đầy đủ của lượt này lưu tại `/Users/huytran/nailiq-audit-results-20260907/card-manual-review-20260910`.
