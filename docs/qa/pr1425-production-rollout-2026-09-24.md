# PR #1425 — Production rollout

Ngày 24/09/2026 Vancouver (25/09 UTC). Theo phê duyệt rõ ràng của Huy:
merge/deploy sau CI bắt buộc PASS; không migration, provider hoặc thông báo.

## Trước phát hành

- Head được duyệt: `b56925d0d341a643e0369c9b89ded6856d71f749`.
- CI `36079187106` và E2E `36079187108`: 20 SUCCESS, 2 SKIPPED có điều kiện
  (MQA-0148, AI Triage), không pending/FAIL. Không tính skipped là PASS.
- PR Ready, MERGEABLE; main trước merge là `15caa385fcd6357b1ff3b8ed02ef432d73c17296`.
- Phạm vi sáu file: helper identity guard, regression tests, ba tài liệu QA,
  và khóa Git deployment riêng nhánh. Không migration.
- Mốc Production trước đó: `dpl_CXtHFN5AtkXQiTJtLhtiRePVYwFV`, READY,
  `nailiq-om7qbumcd-bepnhobencha-2588s-projects.vercel.app`.

## Phát hành

- Merge bằng `--match-head-commit` để không merge nhầm revision.
- PR #1425 MERGED lúc `2026-09-25T01:11:52Z`.
- Merge SHA: `a8e5fafcc43e5c9c95bc7ed992dc75f7bd2b0996`.
- Checkout detached sạch: `/private/tmp/nailiq-pr1425-production-a8e5fafc`.
  Diff nội dung giữa merge SHA và head đã CI PASS bằng rỗng.
- Deploy CLI đúng project `nailiq`, project ID
  `prj_1yP37n3CAzbk5BaXizY5TWcOa7gV`, target Production.
  Không promote Preview dùng QA, không pull/copy env QA sang Production.
- Deployment `dpl_5Er8jXgSjokEgRo2fp2RPqSfmkEN` READY.
- URL: https://nailiq-mol5zthw1-bepnhobencha-2588s-projects.vercel.app
- Vercel metadata `gitCommitSha` khớp merge SHA; aliases gồm `www.nailiq.ca`
  và `nailiq.ca`. Không thay WAF, salon settings hoặc feature flags.

## Kiểm chứng chỉ đọc

- Lúc `2026-09-25T01:14:11.750Z`, trong khi build, version/health/readiness
  của bản cũ vẫn PASS.
- Lúc `2026-09-25T01:14:52.796Z`, cả ba endpoint PASS ngay lần đầu và cùng
  trả deployment identity `dpl_5Er8jXgSjokEgRo2fp2RPqSfmkEN`.
  CLI deployment dùng deployment ID cho runtime version; SHA được đối chiếu
  riêng bằng metadata Vercel, không giả vờ runtime trả commit SHA.
- `/hilite-anaheim` và `/hilite-studio`: HTTP 200, HTML.
- Quét log level error của riêng deployment mới sau hơn một phút READY:
  0 rows, không dòng không parse được. Lệnh đầu thiếu project link đã thất
  bại, không dùng kết quả đó; chạy lại với project ID/scope rõ ràng thành công.
  Chỉ là cửa sổ đầu sau release, không khẳng định không bao giờ có lỗi.
- Không cấu hình thêm log drain; kiểm tra lần này dùng runtime logs Vercel
  và các endpoint monitor hiện có, không chứng nhận toàn bộ coverage giám sát.
- Đây là release/health/readiness smoke, không thay kiểm thử đầy đủ tất cả
  salon, authenticated mutations hoặc provider delivery.

## Giới hạn và rollback

- Không tạo booking, không mời khách Live, không gọi cron thủ công, không
  gửi SMS/email/call/payment. Không sửa database hoặc credentials.
- P1-01 terminal provider delivery, người dùng mới và iPhone vật lý vẫn
  NOT PROVEN. Issue joinedAt timezone trình duyệt còn mở ngoài guard này.
- Nếu phát hiện regression do release, mốc rollback là deployment READY
  trước đó ở trên; không chạy rollback trong lượt kiểm chứng thành công này.
- Tài liệu hậu-deploy này giữ local, chưa commit/push thêm vào main.
