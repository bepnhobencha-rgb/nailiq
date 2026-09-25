# Reminder Recovery — review gate, 25/09/2026 UTC

## Quyết định có bằng chứng

PR #1427 tại `438d46f0217ca14e45fdb265acaf6d9f7b402b8a` hiện OPEN,
Draft, MERGEABLE, merge state CLEAN (read-only check trong lượt này).
Đủ bằng chứng để đề nghị review hotfix; chưa đồng nghĩa duyệt Production
hoặc đóng toàn bộ P1-01/Master Plan.

| Cổng | Trạng thái |
| --- | --- |
| Local unit/contract, typecheck, lint, build | PASS theo receipt recovery |
| Local PostgreSQL handler 14 ca, provider mock | PASS |
| CI head hiện hành, attempt 1 | PASS; 2 job skip theo điều kiện, không phải load-test PASS |
| Preview đúng head | READY, dpl_4GRC2as8yA4fxy31mPxzfpMcZrem |
| Hosted QA synthetic recovery/skip/suppression | PASS |
| Hosted concurrent worker + replay | PASS lượt mới; giữ lỗi transport lượt đầu |
| Cleanup fixture | PASS; metadata vận hành QA được giữ lại |
| Actual scheduled trigger | NOT PROVEN |
| Unsuppressed sender, provider terminal delivery, Inbox/SMS | NOT PROVEN |
| Customer reminder-link navigation | NOT PROVEN; canonical QA URL vẫn placeholder |
| Production rollout / pilot | NOT PERFORMED |

Chi tiết: [hosted synthetic report](p1-01-reminder-hosted-synthetic-2026-09-25.md)
và [hosted preflight](p1-01-reminder-hosted-preflight-2026-09-25.md).

## Bước tiếp theo, đúng phạm vi

1. Xin duyệt publish ba tài liệu QA mới của lượt này vào chính PR #1427,
   cập nhật mô tả PR bằng bằng chứng mới và chuyển Ready for review.
   Không kèm merge, Production hoặc provider.
2. Chỉ stage ba file dưới đây; không lấy các thay đổi dirty từ lượt khác:
   - `docs/qa/p1-01-reminder-hosted-preflight-2026-09-25.md`
   - `docs/qa/p1-01-reminder-hosted-synthetic-2026-09-25.md`
   - `docs/qa/p1-01-reminder-review-gate-2026-09-25.md`
3. Nếu publish đổi head, kiểm CI head mới; Preview hiện tại thuộc head cũ.
   Dù documentation-only, không gọi Preview là deployment của head mới.
4. Provider/scheduler/customer-link proof là cổng riêng. Phải xác định recipient,
   giới hạn số tin, môi trường và rollback trước khi xin duyệt; không tái dùng
   quyền gửi một email QA đã dùng hết. Không thay lịch cron Production để test.

## Rollback và tác động cần hiểu trước Production

Không có migration trong hotfix. Nếu được phát hành sau này, rollback về build
application trước đó; giữ nguyên durable claims, không xóa hoặc reset attempts.
Hotfix có thể tự recovery các claim lỗi đủ điều kiện trong 60 phút ở salon đang
bật reminder. Vì vậy merge/deploy không đồng nghĩa không thể phát sinh tin gửi
thật ở lần cron kế tiếp; cần duyệt riêng tác động này trước Production.

Chưa commit/push ba tài liệu, chưa cập nhật PR qua mạng và chưa chuyển Ready
trong lượt lập gói review. Không ghi đè các file dirty khác trong worktree.
