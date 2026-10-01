# SMS/Waitlist — QA hosted migration và rehearsal

Ngày 01/10/2026. Phạm vi: Supabase QA disposable `uhpzafoiifupyypkcwln`,
Preview branch `qa/masterplan-day21-pilot-kit-20260929`. Không Production.

## Đã kiểm chứng

- Project identity đọc lại từ connected Supabase; hai tenant đều synthetic.
- Cả hai tenant tắt SMS/email outbound. Preview có bốn biến Supabase riêng
  branch trỏ QA và 19 kill switch OFF; không sửa biến Production.
- Áp theo thứ tự bốn file migration: `20260930221321`, `20261001011654`,
  `20261001023547`, `20261001031038`; mỗi lượt có transaction, lock timeout
  3 giây và statement timeout 30 giây. Bốn lượt trả success.
- Đọc lại function signatures, definition fingerprints và ACL. RPC inbound
  chỉ service_role được EXECUTE; helper nội bộ không cấp quyền cho ba role
  anon/authenticated/service_role. Các definer dùng search_path rỗng.
- Receipt ledger FORCE RLS; ba role trên không đọc/ghi trực tiếp.
- **16 ca SQL hosted PASS**: apply, trạng thái, retry nguyên kết quả, không
  retarget lịch kế tiếp, một event, mismatch, không có target, SID sai,
  account sai, RPC ACL, receipt ACL, JWT backstop, update/delete immutable,
  unique failure cuối giao dịch và rollback đồng bộ.
- Fixture và thao tác synthetic nằm trong transaction ROLLBACK. Kiểm tra
  sau rollback không còn tenant/command receipt của lượt này. Không mock RPC,
  không gọi route cron hay provider; không gửi SMS/email.
- Fingerprints salon, booking, Waitlist và auth user trước/sau migration
  giữ nguyên. Snapshot function/ACL trước áp lưu riêng ngoài repository.
- Security Advisor: trước 76 INFO / 21 WARN / 0 ERROR; sau 77 INFO / 21 WARN /
  0 ERROR. INFO mới là ledger RLS không policy, đúng chủ ý private service RPC.
  Không gọi các WARN có sẵn là đã sửa.

Pre-publication: 237/237 focused tests PASS (19 files), typecheck PASS,
source lint 0 errors / 3 warnings hiện có, diff check PASS. Supabase MCP
ghi migration history với timestamp lúc áp, theo đúng thứ tự:
`20261001103042`, `20261001103108`, `20261001103110`, `20261001103112`.
Đây là mapping QA với bốn file nguồn, không đổi tên migration trong Git.

## Giới hạn bắt buộc giữ

SQL hosted không chứng minh HTTP callback hoặc Next background dispatch trên
Preview. Adapter atomic vẫn OFF khi kiểm preflight; chỉ bật riêng QA khi
thực hiện cổng HTTP kế tiếp. Chưa có provider delivery, scheduler thật, thiết
bị vật lý hoặc pilot người thật. Ngày 22 chưa đóng; Master Plan NOT PROVEN.

## Phân tách xuất bản

Batch xuất bản chỉ SMS/Waitlist và hồi phục booking liên quan. Các thay đổi
pilot, Square deadline và tài liệu bàn giao khác giữ riêng, không commit mù.
Giữ PR #1441 Draft, không merge/deploy Production. Những report local trước
đó vẫn là bằng chứng local, không đổi nhãn thành hosted PASS.

## Khôi phục

Nếu cần rollback QA, tắt adapter trước; dùng snapshot function trước migration
và giữ empty search_path/ACL đã harden. Không xóa receipt ledger có dữ liệu
mù; export/đối chiếu receipt trước mọi rollback destructive. Xem rehearsal
`waitlist-function-rollback-local-2026-10-01.md`. Không áp các bước này lên
Production trong phạm vi hiện tại.
