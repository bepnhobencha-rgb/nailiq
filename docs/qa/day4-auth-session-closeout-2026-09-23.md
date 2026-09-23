# Ngày 4 — Auth session: ứng viên đóng nghiệm thu

Ngày: 23/09/2026. Phạm vi: local và QA, không Production.

## 1. Phạm vi bản sửa

- Base: `bd6fadfd552bcca490b41b67d7eb01c8309772be` (main đọc lại từ GitHub).
- Chỉ tách hotfix Auth khỏi worktree QA cũ; không đem endpoint QA tạm,
  recipient guard, khóa, môi trường hoặc hồ sơ có email cá nhân vào bản sửa.
- Hai lỗi exchange `flow_state_expired` / `flow_state_not_found` chuyển tới
  mã nội bộ `link_session_expired`, có hướng dẫn EN/VI để đăng nhập bằng cách
  đã dùng. Không khẳng định email đã confirmed từ query string.
- PKCE verifier thiếu giữ `pkce_restart`; lỗi lạ giữ `session`. Không bỏ
  signature/PKCE, không tạo session khi exchange lỗi, không tăng hạn token,
  không tự gửi lại thư hoặc thay đổi mật khẩu.

## 2. Bằng chứng hosted đã có, không phải của ứng viên này

Preview trước tại SHA `34bcafa4d4a66654c372bdfef77cee90a1805a91`:

| Cổng | Kết quả |
| --- | --- |
| Signup → signed NailIQ hook → provider delivery | PASS đúng lượt được duyệt |
| Thư signup đến hộp thư iCloud | PASS nhận; FAIL Inbox placement (Junk) |
| Mở signup link sau khoảng 53 phút | Confirmed, nhưng flow hết hạn, chưa login |
| Fresh magic-link → callback → session | PASS; thư Supabase mặc định vào Inbox |
| Salon riêng, đúng Owner, 14 ngày trial | PASS QA qua UI + DB readback |
| Default an toàn, không booking/payment/outbound | PASS QA |
| Reload giữ salon/membership/trial | PASS QA |
| Coco Setup và form địa chỉ ở mobile 390×844 | Không tràn ngang; có copy EN/VI chưa đồng nhất |
| Cleanup salon synthetic | Chờ duyệt; Auth account sẽ được giữ |

Không dùng kết quả email mặc định để thay kết quả Inbox của template NailIQ.
Không dùng thành công QA để tuyên bố Production hoặc pilot đã đạt.

## 3. Kiểm thử ứng viên local

```sh
npx vitest run src/app/auth/callback/route.spec.ts src/app/login/page.spec.ts src/app/login/passwordResetUi.spec.ts src/shared/auth/__tests__/signupConfirmationExperience.spec.ts src/shared/register/__tests__/completeSalonRegistrationAction.spec.ts src/shared/register/__tests__/registrationDefaults.spec.ts src/app/register/setup/page.spec.ts
npm run typecheck
npx eslint src/app/auth/callback/route.ts src/app/auth/callback/route.spec.ts src/app/login/LoginPageClient.tsx src/app/login/page.tsx src/app/login/page.spec.ts src/app/login/passwordResetUi.spec.ts src/shared/i18n/user/en.ts src/shared/i18n/user/vi.ts
git diff --check
```

- 7 suites, 51/51 PASS; typecheck, lint và diff check PASS.
- Next build: PASS (exit 0), chạy riêng sau typecheck; compile, TypeScript
  và tạo 61 trang tĩnh hoàn tất. Có cảnh báo Edge Runtime deprecated;
  không có lỗi build.
- Build dùng môi trường sạch, URL Supabase local không có backend,
  anon key giả; toàn bộ email/SMS/call/payment OFF. Không dùng credential QA
  hoặc Production trong local build.
- Rà soát độc lập: PASS, không phát hiện lỗi chặn. Hotfix chưa có trên
  main hoặc PR đang mở tại thời điểm kiểm tra. Một số PR khác cùng sửa
  file i18n/test; cần kiểm tra lại xung đột trước khi publish/merge.

## 4. Điều kiện trước khi ghi ĐÓNG

1. Duyệt publish hotfix thành PR/Preview, chỉ QA; rerun CI và xác minh UI
   trên chính SHA ứng viên, không dùng Preview cũ làm bằng chứng code mới.
2. Nếu duyệt đúng một lượt branded magic-link QA mới: dùng guard mới pin đúng
   project/recipient/callback/action, thời hạn hữu hạn, idempotency cố định;
   mở ngay trong cùng browser. Không click nút gửi trong preflight.
3. Khi không được phép gửi, Hook QA phải nối vào guard có flag OFF. Chỉ
   Disabled Hook không đủ chặn default SMTP fallback. Không gửi để thử OFF.
4. Dọn đúng synthetic salon đã pin UUID/created_at/owner; không dùng helper
   xóa tất cả salon của user hoặc xóa toàn bộ rate_limits. Giữ Auth account.
5. Nếu branded Inbox vẫn thất bại, ghi FAIL và nguyên nhân chưa được chứng
   minh; không gửi lặp, không đổi DNS/Production hoặc hạ điều kiện nghiệm thu.

Trạng thái: **LOCAL CANDIDATE, chưa publish; Ngày 4 chưa đóng toàn bộ.**

## 5. Rollback

- Hotfix chỉ thay UX callback/login: revert đúng commit hotfix khi có commit;
  không có migration hay yêu cầu rollback database.
- QA send rehearsal độc lập với ứng dụng: trả flag gửi về OFF, giữ signed
  guard chặn fallback. Không thay sender/auth Production.
