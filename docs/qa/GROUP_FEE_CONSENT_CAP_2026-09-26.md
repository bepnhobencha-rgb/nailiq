# Phí hủy nhóm — bản sửa giới hạn consent, 2026-09-26

## Kết luận

**Local PASS; chưa phát hành.** Nhánh `fix/group-fee-consent-cap-20260926`, base `1ecbe7b71978a924f7ddfbb8d712f5f46adeaac1`. Thay đổi chưa commit/push. Không gọi provider, không thu tiền, không gửi SMS/email và không thay đổi Production trong lượt này.

## Bằng chứng trước sửa

- Production `/api/version` đọc trong lượt audit: `278bd63302bfa91d670f35fe0616f4fe04b6a92b`. PR #1431 đã merge vào main nhưng chưa chứng minh được deploy Production.
- Hai salon `hilite-anaheim`, `hilite-studio`: salon flag approved cancellation/no-show dispatch bật, self-cancel 10%, cửa sổ24h, no-show20%. Đây là bằng chứng cấu hình DB, không phải bằng chứng provider đã thu.
- Fee review nhóm: Anaheim0, Studio3;0 pending/approved/succeeded. Studio2 outside_fee_window và1 short_notice_grace_active. Không có lỗi thu tiền được xác minh ở ba phiếu này.
- Lỗi tái hiện bằng synthetic: nhóm CAD250, consent CAD50, no-show lúc đầu20%. Đổi no-show hiện tại xuống5%, giữ late20% → preview và Owner-approved claim CAD200. Không gọi provider. Test hồi quy trước sửa FAIL đúng tại rate-drift.

## Bản sửa local

Migration `20260926145844_bind_group_cancellation_fee_consent_cap.sql`:

- Không suy ra khách chấp nhận số tiền cao hơn từ tỷ lệ hiện tại. Giữ số tiền ứng viên, chặn khi vượt consent, phí đã lưu hoặc tỷ lệ<=20% trên giá trị đúng phạm vi trách nhiệm.
- `booking_member` chỉ dùng giá trị của người tổ chức; `whole_party` dùng giá trị các lịch đang hoạt động trong nhóm.
- Preview lưu `fee_guard` có consent amount/scope/currency/policy, timestamp/hash, hash card/customer, receipt và provider binding. Không lưu thêm card token hoặc PII.
- Trước operation mới, kiểm tra lại guard và durable receipt. Legacy review thiếu guard bị chặn; không tự sửa số tiền đã Owner duyệt.
- Square customer/merchant/environment phải khớp. Giữ nguyên nhánh operation hiện hữu, reconciliation và provider request reference.
- Hủy vẫn thực hiện được khi phí bị chặn, lưu `fee_reason` trong receipt/replay. Không tự thu/miễn phí hoặc thay đổi chính sách sản phẩm.
- Lễ tân và hàng đợi thu phí hiển thị lý do cần kiểm tra bằng EN/VI, không gọi trường hợp này là “không áp dụng phí”.

Files: một migration; SQL rehearsal + workflow chạy rehearsal; helper `groupFeeSafety`; copy/fee error mapping trong hai màn lễ tân, FeeCollectionConfirmation và parser receptionistActions; unit tests, dynamic-SQL inventory và fixture trình duyệt.

## Kiểm thử thực tế đã chạy

| Kiểm tra | Kết quả |
|---|---|
| Focused unit, fee executor, policy/action/route, EN/VI |75 PASS|
| Dynamic SQL inventory |7 PASS|
| Migration trên hai DB local disposable |PASS|
| SQL integration trên DB sạch từ migration |38 assertions PASS, ROLLBACK|
| Duplicate claim/unknown giữ1operation, original amount |PASS trong SQL|
| Completion bằng receipt synthetic và không tạo charge thứ hai |PASS trong SQL|
| Tenant denial và service-only ACL |PASS trong SQL|
| Typecheck |PASS|
| Lint touched TS/TSX |PASS|
| Next build mặc định Turbopack |Bị môi trường chặn bind port, chưa PASS|
| Next production build `--webpack` |PASS|
| Chromium desktop + WebKit mobile, EN/VI, group queue |32 PASS|

DB sạch thiếu grant bootstrap auth.users của role postgres: fixture chạy bằng supabase_admin tại local; không mở rộng grant Production. RPC vẫn kiểm tra tenant/actor và bài test ACL xác nhận anon/authenticated không có EXECUTE.

Browser dùng component production trong fixture độc lập; server actions giả, mọi off-origin request bị chặn. Đây là UI QA local, **không phải Hosted Preview hay Square Sandbox E2E**. Chưa chạy lại full suite, race đa kết nối hay provider sandbox trong bản sửa này. Chưa chứng minh thu tiền thật.

## Giới hạn và việc tiếp theo

- Sửa đường salon hủy cả nhóm → Owner/Admin duyệt → xác nhận Thu riêng. Chưa bổ sung public whole-party cancellation; SQL nội bộ đó vẫn chưa có TS caller và chưa tạo group fee review.
- Không thay đổi việc một thành viên tự hủy chỉ phần của mình hoặc tạo quyền thu tiền từ người khác.
- Công thức cá nhân có cùng mẫu dùng tỷ lệ hiện tại: cần audit/fix riêng trước kết luận toàn bộ phí hủy đã hoàn chỉnh.
- Bản sửa chỉ chặn NEW claims; không viết lại operation đã gửi/unknown. Việc xác minh booking trước nhánh replay là hành vi cũ, không đổi trong scope này.
- Review cũ thiếu guard sẽ cần xử lý thủ công, không được backfill consent suy đoán. Guard failure vẫn lưu reason nhưng chưa có màn exception chuyên biệt.
- Huy đã duyệt commit/push/PR và QA Preview cho bản sửa mới ngày2026-09-26; sau đó CI/Preview + Square sandbox mới kết luận đủ điều kiện phát hành. Không dùng approval PR1431 cho thay đổi này.

## Rollback

1. Trước rollout được duyệt, export `pg_get_functiondef` của3RPC: preview_booking_group_cancellation_for_desk, claim_approved_cancellation_fee_payment, cancel_booking_group_for_desk_with_decision_truth.
2. Nếu cần dừng thu, dùng release/tenant dispatch gate theo phê duyệt của Owner; lưu ý gate cancellation hiện dùng chung với hủy cá nhân. Giữ toàn bộ ledger, approval và operation đang đối soát.
3. Ưu tiên forward fix. Nếu restore3functiondefinitions cũ, phải giữ collection tắt vì bản cũ mở lại lỗi tăng tiền. Không xóa fee_guard/receipts, không đổi material/idempotency key hoặc phát lại yêu cầu chưa rõ kết quả.

Trạng thái: Existing before task=desk approval/collect flow; Implemented locally=cap/binding/disclosure; QA tested=local; Preview verified=chưa; Deployed=chưa; Production verified=chỉ audit read-only ở trên.
