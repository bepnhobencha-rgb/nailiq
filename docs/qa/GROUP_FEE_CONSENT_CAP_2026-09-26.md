# Phí hủy nhóm và biên nhận thu phí — 2026-09-26

## Vấn đề và bản sửa

Nhóm synthetic CAD250 với consent CAD50 có thể sinh claim CAD200 sau khi tỷ lệ no-show thay đổi20%→5%. Migration `20260926145844_bind_group_cancellation_fee_consent_cap.sql` chặn claim mới vượt consent, số tiền đã lưu hoặc trần<=20% trên giá trị đúng phạm vi trách nhiệm. Preview lưu guard consent/card/customer/receipt/provider; claim mới kiểm tra lại binding. Legacy review thiếu guard bị chặn, không suy đoán consent hoặc sửa số tiền đã duyệt. UI EN/VI giải thích lý do bị chặn; khách vẫn hủy được.

Một giao dịch Square Sandbox CAD1 đã hoàn tất nhưng replay trả `booking_payment_material_invalid`: SQL kiểm tra booking đã `charged` trước khi đọc operation thành công. Migration `20260926170510_replay_approved_cancellation_fee_receipts_before_mutable_booking_checks.sql` đọc exact request sau tenant/Owner/Admin/approval checks, trước mutable eligibility; xác nhận review/material/request/amount/currency và biên nhận. Giữ thứ tự khóa review→booking→operation. Chỉ NEW operation kiểm tra thẻ/trạng thái hiện tại. Không đổi operation cũ, idempotency key hoặc chính sách reconciliation.

Executor trả receipt đã lưu khi một worker khác hoàn tất trước lúc reconciliation lấy khóa; receipt lỗi trả `unknown`, không giả thành công hay tạo charge mới. UI vẫn tách Owner duyệt và xác nhận Thu. Không bật tự động thu cho hủy nhóm trong bản sửa này.

## Kiểm chứng theo môi trường

- **Existing before task:** desk whole-party cancellation → fee review → Owner approval → separate collection; payment ledger và provider idempotency đã tồn tại.
- **Implemented locally:** consent cap/binding, EN/VI blocked reason, successful receipt replay và completion race handling.
- **Local QA:**48 SQL assertions trên DB sạch từ migrations, transaction rollback;202 unit/payment/inventory tests; typecheck và touched-file lint. Next Webpack production build cuối PASS. Regression replay trước sửa FAIL đúng; sau sửa PASS cá nhân và nhóm. Card removal/version drift không làm mất receipt. Sai tenant/member/review binding bị chặn.
- **Hosted Supabase QA:** cả hai migrations đã áp dụng; SQL rollback rehearsal48 assertions không có lỗi. Không có provider calls trong rehearsal.
- **Square Sandbox:** đúng một giao dịch được Huy duyệt, CAD1, COMPLETED; read-only provider kiểm tra đúng một matching payment. Local migrated SQL + executor lưu succeeded. Replay sau sửa dùng lại receipt, zero provider calls, vẫn một operation. Đây là local SQL→Sandbox, không phải hosted dispatch hoặc tiền thật. ListPayments lần đầu chậm cập nhật, resolved bằng read-only verification.
- **CI tại1f5650db trước replay fix:**25 checks SUCCESS,2 conditional SKIP;7030 unit PASS/79SKIP; folded migration38assertions; broad E2E +10 no-retry WebKit booking repetitions PASS. Không dùng các số này làm chứng nhận head mới.
- **Preview tại1f5650db trước replay fix:** authenticated Computer Use: inflated group fee bị chặn; valid CAD50 vào review, duyệt và reload persist; dialog Thu hiển thị đúng tiền/card, không submit. Mỗi nhóm1review/0payments. Preview payment/card dispatch và outbound OFF. Head replay mới cần CI/Preview riêng.
- **Deployed / Production verified:** chưa phát hành thay đổi này. Production SHA từng đọc278bd633; cần đọc lại trước rollout. Hai salon có tenant flags bật không chứng minh provider đã thu.

Bằng chứng bổ sung ngoài repository: `/Users/huytran/nailiq-group-recovery-evidence-20260925/group-fee-audit/` (CI, hosted Computer Use, Square Sandbox). Secrets/private manifests không thuộc repository.

## Giới hạn phạm vi

- Luồng salon hủy cả nhóm và Owner/Admin thu riêng được sửa; không bổ sung public whole-party cancellation caller hoặc tự thu khi một thành viên rút khỏi nhóm.
- Công thức phí cá nhân theo tỷ lệ hiện tại chưa được chứng nhận consent-cap đầy đủ trong task này; sửa replay cá nhân không phải chứng nhận toàn bộ chính sách đó.
- Feature gates/provider resolution trước executor vẫn có thể chặn action khi cấu hình không sẵn sàng. Không nới gate để trả receipt; ledger remains source of truth.
- Reconciliation hiện hữu có thể redispatch bằng cùng immutable idempotency key; không gọi đó là read-only reconciliation.
- Không gọi Square Production, không thu khách thật, không SMS/email/call để kiểm thử.

## Release và rollback

PR#1432 trên nhánh `fix/group-fee-consent-cap-20260926`. Publish batch hoàn chỉnh, chạy CI và QA Preview đúng head. Trước rollout Production phải kiểm tra SHA/schema thực tế, export3functiondefinitions (preview_booking_group_cancellation_for_desk, claim_approved_cancellation_fee_payment, cancel_booking_group_for_desk_with_decision_truth), áp dụng cap rồi replay, deploy app đúng commit với Production config. Không promote QA build chứa QA credentials.

Nếu cần rollback: ngừng collection bằng dispatch gate, giữ ledger/approval/receipts và đối soát operation đã gửi. Ưu tiên forward fix. Restore code/function cũ chỉ khi collection tắt vì mở lại cap/replay bug. Không xóa ledger, đổi idempotency/material hoặc gửi lại payment chưa rõ kết quả.
