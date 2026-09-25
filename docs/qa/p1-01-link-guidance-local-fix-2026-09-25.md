# P1-01 — Sửa hướng dẫn link và màn hình hủy (local)

## Phạm vi

Huy duyệt `y` cho bước sửa tiếp theo sau synthetic hosted QA. Branch
`fix/reminder-recovery-20260925`, base HEAD `dbbc9b8748bee6c63391ebf45271d57f6652fe21`.
Giữ nguyên các tài liệu đang dirty từ công việc trước. Chưa commit/push/deploy.

## Thay đổi

- Confirm/cancel dùng thông báo rõ cho link đã sử dụng, hết hạn/thu hồi,
  lịch thay đổi, link thiếu/sai và lỗi chưa xác minh. Có hướng dẫn Anh/Việt.
- Không coi `token_consumed` là bằng chứng trạng thái hiện tại đã xác nhận/hủy;
  không tiết lộ thông tin lịch qua link không còn hợp lệ.
- GET cancel trả thêm đúng bốn trường từ capability đã xác thực: tên tiệm,
  dịch vụ, thời gian bắt đầu UTC và timezone. Không trả toàn bộ inspection,
  thông tin liên hệ hay context nội bộ.
- Màn hình hủy hiển thị thông tin trên trước nút xác nhận, dùng formatter giờ
  salon sẵn có. Không thay đổi POST, idempotency, chính sách phí, DB hoặc quyền.
- Không sửa luồng reschedule trong batch này.

## Kiểm chứng

Các lệnh chạy tại worktree; unit/build dùng môi trường sạch, SMS/email/call OFF.

```sh
./node_modules/.bin/vitest run src/shared/booking/bookingManagementLinkMessage.spec.ts src/app/api/booking/cancel-action/route.management.spec.ts src/app/api/booking/confirm-action/route.spec.ts src/shared/security/__tests__/capabilityTokenBoundary.spec.ts
npm run typecheck
./node_modules/.bin/eslint src/app/booking/confirm/page.tsx src/app/booking/cancel/page.tsx src/app/api/booking/cancel-action/route.ts src/app/api/booking/cancel-action/route.management.spec.ts src/shared/booking/bookingManagementLinkMessage.ts src/shared/booking/bookingManagementLinkMessage.spec.ts
./node_modules/.bin/eslint e2e/management-link-guidance.spec.ts playwright.management-guidance.config.ts
npm run build
./node_modules/.bin/playwright test --config playwright.management-guidance.config.ts --output test-results-management-guidance-run2
git diff --check
```

- Unit/route/security: **33/33 PASS**. Dependencies của route được mock.
- TypeScript, lint, diff whitespace: **PASS**.
- Build: lần đầu đứng ở compile trong sandbox (0% CPU), đã dừng đúng tiến trình.
  Chạy lại ngoài sandbox với môi trường sạch: **PASS**, compile 7.9 giây.
  Cảnh báo Vite config và Edge Runtime deprecated vẫn còn.
- UI Chromium, viewport 390×844, browser timezone UTC: **7/7 PASS lượt 2**.
  Lượt 1 **7/7 FAIL** vì proxy thiếu URL/key Supabase, không vào được trang.
  Sửa môi trường local bằng URL `http://127.0.0.1:9` và key giả
  `synthetic-ui-only`, không dùng credential thật. Tất cả API của test được mock.
- Server chạy `next start --hostname 127.0.0.1 --port 3197`; đã dừng sau test.
- Kiểm tra ảnh chụp màn hình hủy: salon, dịch vụ, Sep 29 1 PM PDT đúng,
  nằm gọn khổ điện thoại, hai nút rõ. Không có mutation trước khi bấm xác nhận;
  đúng một POST mock sau khi bấm.
- Bằng chứng lượt 1 ở `test-results/`; ảnh lượt 2 ở
  `test-results-management-guidance-run2/`. Không gộp/stage chúng tự động.

## Kết luận và giới hạn

**PASS local cho phạm vi sửa.** Chưa kiểm chứng hotfix trên hosted Preview,
Production hay iPhone thật. API mock không chứng minh backend/provider delivery.
Chưa đóng Ngày 7 hoặc Master Plan. Không migration, dữ liệu thật, SMS/email,
provider, commit, push hoặc deploy trong batch này.
