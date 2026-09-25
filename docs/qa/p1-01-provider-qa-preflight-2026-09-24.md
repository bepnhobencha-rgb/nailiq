# P1-01 — Điều kiện kiểm chứng provider QA

Ngày 24/09/2026 Vancouver. Tiếp sau rollout PR #1425, không mở rộng roadmap.

**Snapshot lịch sử trước lượt gửi được duyệt.** Kết quả mới hơn nằm trong
`waitlist-one-email-provider-2026-09-24.md`: một email QA đã Delivered,
khóa tạm đã thu hồi và email QA đã tắt lại. Các câu “chưa gửi” bên dưới
chỉ mô tả thời điểm preflight, không phải trạng thái hiện hành.

## Kết quả hiện tại

- Production đã phát hành PR #1425; không dùng Production để thử gửi.
- Chỉ đọc cấu hình riêng Preview branch `fix/waitlist-invite-identity-20260924`.
- SMS/email/call disable=1; disposable DB và Resend QA-only đều =1.
- Người nhận QA rỗng; RESEND_API_KEY và RESEND_FROM rỗng;
  RESEND_WEBHOOK_SECRET không có override riêng branch.
  Không suy rằng secret effective bị thiếu vì có thể có giá trị inherited;
  trước khi bật gửi phải pin secret QA riêng, không dùng inherited Production.
- Không đọc/in/lưu giá trị secret hoặc thay env. Không gọi Resend.
- Mã resolveResendQaBoundary chặn nếu recipient/project/environment không
  đúng. QA tags chỉ cấp cho đúng người nhận đã pin. Production bỏ qua QA tags.
- Webhook kiểm chữ ký trước database, rồi lọc QA scope trước ghi event.
- 54/54 tests ở 4 file PASS: webhook route, owner/customer delivery boundary,
  deliverPromotedWaitlistOffer. Đây là unit/mock, không phải provider proof.

## Gói thực hiện sau phê duyệt riêng

1. Dùng QA hiện có và một salon/entry synthetic riêng; SMS/call/payment giữ OFF.
2. Pin đúng QA ref, URL và người nhận được Huy chỉ định. Chuẩn bị sending-only
   credential dùng riêng QA, From đã verified và secret callback QA riêng.
   Không sao chép hoặc đổi credential/config Production.
3. Kiểm tra webhook QA có thể nhận POST của provider qua deployment protection
   và WAF; mọi thay đổi security/publication phải duyệt ở đúng ranh giới.
   Không gửi trước khi chứng minh callback tới đúng QA, không mở rộng bypass.
4. Chỉ cho phép email với đúng recipient, một entry/offer epoch. Bật duy nhất
   email của fixture và Preview trong cửa sổ kiểm thử được phép.
5. Bấm Mời ngay một lần qua UI. Ghi outbox identity, provider receipt và signed
   terminal callback. Không bấm claim, không tạo booking. Không log contact/token.
6. Nếu timeout/unknown, không gửi lại tự động. Đối chiếu receipt trước; dùng
   durable outbox để chống double-send, không tạo epoch mới để vượt giới hạn.
7. Chỉ PASS giao nhận khi callback đúng message/recipient fingerprint/salon
   cho trạng thái terminal. Provider accepted không phải delivered; delivered
   không tự chứng minh Inbox thay vì Junk. Inbox cần kiểm chứng riêng.
8. Tắt lại email QA, giữ mọi kênh khác OFF, dọn fixture và thu hồi phiên.
   Không xóa receipt cần lưu bằng chứng trước khi đối chiếu đủ; không để
   contact hoặc capability trong tài liệu. Không thay Production.

## Ranh giới kết luận

Một email thành công chỉ đóng ca email tương ứng, không đóng toàn bộ P1-01:
SMS terminal, opt-out, reminders 24h/3h, bounce/complaint và người dùng thật
vẫn cần chứng cứ riêng. Không chạy bù hoặc tạo dữ liệu salon kinh doanh.

Chưa gửi, chưa cấu hình provider/webhook, chưa redeploy, chưa commit/push.
Chưa thể chạy bước provider khi chỉ có phê duyệt rollout không gửi thông báo.
