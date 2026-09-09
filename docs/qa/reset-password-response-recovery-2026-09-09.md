# Đổi mật khẩu: giữ form khi mất phản hồi — 2026-09-09

Trạng thái: **PASS local, chưa phát hành**. Nhánh `fix/reset-password-response-recovery-20260909`, base `bd7c4ca42a0e3ff650ade1a6ad15789e21c2f1b6` (PR #1367 đã merge).

## Lỗi được tái hiện

Mức cao: component đặt mật khẩu mới gọi Server Action trong `startTransition` nhưng không bắt rejection của request. Khi phản hồi bị mất, React chuyển sang error boundary và gỡ form cùng hai ô mật khẩu.

Cách tái hiện an toàn: build fixture riêng, nhập hai mật khẩu giả giống nhau vào component thật, chặn request `next-action` bằng `route.abort("failed")`, bấm đặt mật khẩu. Baseline Chrome/Safari: **2/2 tái hiện form bị thay bằng error boundary**. Đây là kiểm tra runtime của component và Next action decoder; không phải phiên khôi phục tài khoản thật.

## Bản sửa

- Bắt rejection ngay quanh lời gọi action. Giữ hai giá trị trong bộ nhớ component, không tự gửi lại, không chuyển tới trang báo thành công.
- Hiển thị EN/VI rằng chưa xác nhận được mật khẩu đã đổi; hướng dẫn thử đăng nhập với mật khẩu mới và yêu cầu link khôi phục mới nếu cần.
- Đường quay lại `/login` không mang `reset=ok`. Chỉ kết quả `{ok: true}` được xác nhận mới chuyển tới `/login?reset=ok`.
- Giữ các lỗi nghiệp vụ có kiểu, validation và trạng thái chờ. Dùng Button/Input, màu lỗi/primary và khoảng cách hiện có.
- Không thay đổi action thật, recovery/session capability, kiểm tra membership, proxy, database hay provider.

## Bằng chứng

| Kiểm tra | Kết quả |
| --- | --- |
| Browser component, EN/VI × Chromium desktop/WebKit iPhone | **40 PASS**, 0 fail/skip/flaky/retry |
| Auth/recovery/session và UI unit, 5 file được chọn | **28 PASS**, 0 fail/skip |
| Build ứng dụng bằng Webpack | PASS |
| Typecheck chạy sau build | PASS |
| ESLint toàn repo | 0 lỗi, 42 cảnh báo; các file mới/sửa không có cảnh báo |
| i18n | 0 lỗi, 13 cảnh báo ở các khóa cũ không sửa |
| CI YAML syntax và diff whitespace | PASS |

40 ca gồm 28 ca lỗi 429/503/abort và bốn lỗi nghiệp vụ, 4 ca validation, 4 ca quay lại đăng nhập không báo thành công, 4 ca ngăn gửi lặp khi đang chờ. Các ca lỗi còn xác nhận giữ cả hai ô, chỉnh sửa xóa lỗi, retry thủ công mới gửi request tiếp theo, điều hướng chỉ sau acknowledgment, không pageerror, không tràn ngang và viền input cùng màu với thông báo lỗi. Đã xem ảnh tiếng Việt trên iPhone; thanh độ mạnh còn dùng màu cũ như trước.

## Bộ kiểm thử độc lập và CI

`qa/password-reset-form` là một Next app thử nghiệm riêng, import component/provider/CSS thật. Chỉ cấu hình của fixture thay action bằng hàm giả lập không có side effect. Bộ test kiểm tra action manifest và dừng nếu build chứa action Auth thật. Tất cả POST bị chặn tại trình duyệt; địa chỉ cố định loopback, không nhận URL Production từ môi trường.

Đã đối chiếu hai build: fixture chỉ chứa `action.ts`; build NailIQ vẫn chứa action thật `shared/auth/salonOwnerAuth.ts` và không chứa hàm giả lập. Không sửa hoặc nới guard của route `/login/reset-password`.

Chạy từ root repo:

```sh
npx next build qa/password-reset-form --webpack
npx playwright test -c qa/password-reset-form/playwright.config.ts
```

Đã thêm job `Password reset form browser` vào cấu hình CI để chạy các ca này sau khi nhánh được push. **Chưa có CI/Preview/Production cho bản sửa mới.** Job mới chưa được xác minh trên Linux.

Hai lỗi trong test ban đầu đã được sửa: dùng sai câu mismatch tiếng Anh và đọc màu trong khi CSS đang transition. Trong lần rà soát harness, alias ban đầu chưa thay action; mọi request vẫn bị chặn tại trình duyệt. Đã sửa replacement, thêm kiểm tra manifest fail-closed và chạy lại 40/40 trên fixture cuối cùng.

## Giới hạn và phần còn lại

- Chưa chạy email khôi phục thật → mở link → commit mật khẩu → đăng nhập trên tài khoản disposable/live. Không dùng kết quả component thay cho bằng chứng end-to-end này.
- Chưa đánh giá tác động runtime Production của bản sửa. Không gửi email, đổi mật khẩu, tạo booking hay sửa dữ liệu của hai salon live.
- Phát hiện qua đọc code, để lô sau: header trang reset vẫn tiếng Anh; meter độ mạnh dùng màu Tailwind trực tiếp; nhánh lỗi đọc membership của trang có gọi global sign-out. Chưa tái hiện runtime các mục này, không gộp vào bản sửa hiện tại.
- 40 ca browser và 28 ca unit không có nghĩa 68 chức năng hay hoàn tất 784 chức năng.

Log/JSON/ảnh và fingerprint lưu trong thư mục audit ngoài repo `reset-password-response-recovery`. Server fixture đã dừng sau test.
