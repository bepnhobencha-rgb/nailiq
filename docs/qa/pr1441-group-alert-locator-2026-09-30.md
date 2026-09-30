# PR #1441 — phục hồi nhóm: sửa bộ chọn kiểm thử

Ngày 30/09/2026. Base `727c75d2a80bd03936fa42d1d5fddf40c29e1e88`.
Chỉ thay test, không thay UI sản phẩm, server action, Auth, database hoặc provider.

## Bằng chứng lỗi, không che lượt đỏ

CI `36742063789`, attempt 1, đúng base: 11 jobs SUCCESS, job Group replacement
recovery browser FAIL. Log job `109978701737`: **31 PASS/1 FAIL**.
Ca Chromium tiếng Việt “uncertain outcome keeps same request and material”
thất bại vì `getByRole("alert")` đồng thời chọn error paragraph của NailIQ
và `__next-route-announcer__` của Next.js. Không phải browser-install failure;
không dùng kết quả này để khẳng định lỗi persistence hoặc regression sản phẩm.

MFA job `109978701889` cùng run: **141 passed (2.3m)**, retries 0.
MFA là fixture action stub, không phải real TOTP hoặc thiết bị vật lý.
Preview `dpl_5zH8EfTcuRCggyK3gUPkdB7ELDvY` READY tại base; READY không phải CI PASS.

## Bản sửa và regression

`qa/group-recovery/recovery.spec.ts`:

- Giới hạn tìm alert trong landmark `main` của fixture.
- Kiểm tra đầy đủ câu lỗi EN/VI cho unknown outcome và contact rejection.
- Chủ động gắn một empty framework alert ngoài `main` trong hai fault tests,
  giữ regression ổn định ngay cả khi route announcer thật chưa mount.
- Không dùng `.first()`, không xóa alert, không tăng timeout/retries, không bỏ
  kiểm tra request ID, contact correction, duplicate submit hoặc reload.

Đã chạy regression trước sửa locator: **1 FAIL** strict-mode alert ambiguity.
Ảnh/context/JSON được giữ trong
`qa/mfa-status/test-results/group-locator-before-fix-20260930/`, không publish
generated artifacts. Regression này mô phỏng đúng điều kiện nhiều alert;
không tuyên bố tái hiện toàn bộ timeline CI lịch sử.

## Lệnh và kết quả thật

| Lệnh | Kết quả |
|---|---|
| `node node_modules/next/dist/bin/next build qa/group-recovery --webpack` | PASS, fixture build |
| `npx playwright test -c qa/group-recovery/playwright.config.ts --project=chromium --grep 'vi: uncertain outcome'` trước sửa locator | FAIL, 1/1, giữ bằng chứng |
| `npx playwright test -c qa/group-recovery/playwright.config.ts` sau sửa | PASS 32/32, 17.1s, Chromium/WebKit, EN/VI, retries 0 |
| `npm run typecheck` | PASS, exit 0 |
| `npx eslint qa/group-recovery/recovery.spec.ts` | PASS, exit 0 |
| `npm run build` clean environment, fake keys, outbound OFF | FAIL local: Turbopack bind port bị `Operation not permitted`; thử với approval escalation vẫn cùng lỗi |
| `npm run build -- --webpack` cùng clean environment/fake keys/outbound OFF | PASS, 61/61 pages, exit 0 |

Không gọi Webpack PASS là default Turbopack PASS. Build & Type Check CI của base
đã SUCCESS trước sửa test; bản sửa vẫn cần CI đúng head mới. Test fixture thay
actions bằng cookie-backed outcomes và chặn mọi request ngoài localhost;
không phải hosted database completion, provider delivery hoặc booking thật.

## Trạng thái và giới hạn

- E2E run `36742063695`, attempt 1, base head vẫn chạy tại checkpoint đóng gói;
  settings recovery và receptionist mobile chưa có kết quả cuối. Không hủy,
  rerun hoặc gọi skipped là PASS.
- Bản sửa local PASS, chưa có CI/Preview của commit mới tại thời điểm viết.
- Giữ PR Draft. Không Ready/merge/deploy Production, migration, booking,
  SMS/email/call/payment hoặc thay dữ liệu salon.
- Human pilot hai salon 7–14 ngày, physical-device/novice timing, provider
  callback/receipt và quyết định self-pay vẫn NOT PROVEN; Master Plan chưa 100%.

Local runtime logs của Preview base được đọc theo aggregate: 16 HTTP 200,
1 HTTP 307, không error/fatal rows trong interval đã kiểm tra từ 16:08 UTC.
Không coi cửa sổ này là chứng nhận mọi route, QA service-role runtime hoặc
Production. `/api/health` bị browser `ERR_BLOCKED_BY_CLIENT` vẫn NOT PROVEN,
không đổi kênh để lách bảo vệ.

## Superseding checkpoint — trước push

E2E `36742063695`, attempt 1, đúng base `727c75d2` đã **SUCCESS**:
10 jobs SUCCESS/2 SKIPPED (MQA-0148 và AI Triage không tính PASS).
Settings recovery job `109978908267` log: **196 passed (15.5m)**.
Đã chờ run kết thúc trước publish vì concurrency có `cancel-in-progress: true`;
không hủy job để lấy head mới. CI riêng vẫn FAIL 31/32 group fixture trên base.
Checkpoint pending phía trên là lịch sử, không phải kết quả cuối của base E2E.
Commit test-only mới cần CI/Preview mới; không dùng base PASS thay thế.
