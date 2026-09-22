# Masterplan Ngày 2 — Đăng ký salon mới từ A đến Z

Ngày kiểm tra: 22/09/2026

Nhánh QA: `qa/masterplan-day2-day3-closeout-20260922`

Preview: `https://nailiq-p0-signup-qa-20260911.vercel.app`

Supabase QA disposable: `uhpzafoiifupyypkcwln`

Kết luận: **PASS HOSTED QA — chưa phải Production/pilot proof**.

## 1. Ranh giới an toàn

- Preview dùng biến Supabase QA riêng theo branch; không dùng dữ liệu salon thật.
- SMS, email, call, payment và provider ngoài Google Auth đều OFF/sandbox.
- Không tạo booking, không gửi thông báo thật, không sửa Production hoặc hai salon Live.
- Dữ liệu owner/salon synthetic đã được xóa sau kiểm tra.
- 13 `service_categories` chuẩn được seed vào QA để khôi phục reference-data parity;
  đây không phải dữ liệu synthetic và được giữ lại cho QA.

## 2. Môi trường hosted đã kiểm chứng

- Vercel deployment: `dpl_8QvgdLkjWcscHBqZbf1s7TwnNj7A`, trạng thái `READY`.
- Stable QA alias ở trên đã được allow-list; không hạ hoặc tắt WAF.
- 28 biến branch-scoped đã được cấu hình kín, gồm QA URL, anon key,
  service-role key và expected project refs.
- Mọi kill switch SMS/email/call/payment/provider/campaign vẫn OFF.
- Không in, log hoặc lưu secret vào repo/tài liệu.

## 3. Hành trình chủ salon thật trên hosted Preview

Tài khoản synthetic: `masterplan-day23-20260922104658@example.invalid`

Salon synthetic: `Masterplan QA Nail Studio 20260922` /
`masterplan-qa-nail-studio-20260922`

Đã thao tác trực tiếp bằng UI:

1. Mở trang đăng ký trial trên Preview.
2. Kiểm tra chuyển English ↔ Tiếng Việt.
3. Đăng nhập bằng tài khoản QA synthetic đã xác nhận sẵn; không gửi email thật.
4. Vào `/register/setup`, nhập tên salon và tạo workspace.
5. Lượt tạo đầu fail-visible vì QA thiếu reference row `service_categories.other`;
   không tạo salon nửa chừng.
6. Seed 13 category chuẩn từ bootstrap reference data của repo vào QA disposable.
7. Thử lại thành công, đi tới màn hình hoàn tất và Coco Setup.
8. UI nêu rõ salon riêng tư, chưa Live, chưa gửi thông báo và chưa thu tiền.

Database readback sau khi tạo:

- đúng một owner membership;
- `profile_complete=false`;
- SMS, email và Voice AI đều `false`;
- `payment_provider=NULL`;
- `subscription_plan=free`, `subscription_status=trialing`, đúng 14 ngày trial;
- 10 dịch vụ mẫu và 1 staff mặc định;
- Coco Setup: `2/8` bước bắt buộc và `2/15` nhóm chức năng.

## 4. Cleanup và kiểm chứng cuối

- Đã xóa user synthetic và salon synthetic tương ứng.
- Readback sau cleanup xác nhận không còn user/salon của ca thử.
- Không có booking, SMS, email, call hoặc payment/provider call được tạo.
- Preview QA vẫn giữ cấu hình branch-scoped để tiếp tục regression an toàn.

## 5. Bằng chứng tự động liên quan

- Signup/email confirmation desktop: **10/10 PASS**.
- Signup/email confirmation mobile: **10/10 PASS**.
- Register/callback/copy/auth guard: **18 PASS**.
- Google recovery UI: **12/12 PASS**.
- Auth/callback/membership/registration contracts: **69/69 PASS**.
- Production build của ứng viên kiểm tra: **PASS**.

Các suite local không thay thế hosted UI; kết luận PASS của tài liệu này dựa thêm
trên hành trình hosted và database readback ở trên.

## 6. Nhận xét UX còn lại

1. Hai thước tiến độ `2/8` và `2/15` đặt gần nhau có thể làm owner mới khó hiểu.
   Nên giữ một tiến độ chính, đưa độ phủ chức năng vào phần chi tiết.
2. Khi Guided/Coco Setup chưa hoàn tất, shell ẩn đường account/logout thông thường.
   Owner mới khó đổi tài khoản; cần một lối **Đổi tài khoản / Đăng xuất** luôn thấy.
3. Timezone mặc định cần được xác nhận rõ thay vì để owner dễ bấm tiếp mà không
   nhận ra tác động tới lịch.

## 7. Kết luận

Ngày 2 được đóng ở mức **PASS HOSTED QA** cho đăng ký salon trắng, owner, trial
14 ngày, private/off defaults và vào Coco Setup. Chưa có thay đổi Production,
chưa kích hoạt salon và chưa có bằng chứng pilot người thật.
