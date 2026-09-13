# R11 — Gói đề nghị duyệt CI và Preview

Trạng thái: **PREPARED, NOT PUBLISHED**. Ngày 13/09/2026. Duyệt gói này chỉ áp dụng commit/push nhánh riêng, PR/CI và QA/Preview riêng; chưa bao gồm merge, Production deploy, thay đổi hai salon Live hoặc thu tiền.

## Gói nguồn cụ thể

- Candidate: `/Users/huytran/nailiq-v1-release-candidate-20260913`.
- Base Git: `0cb441a16387426decaf81b8601df288138d76bc` (Production READY ở lần đọc metadata 15:46:48 UTC).
- Nhánh đề xuất: `fix/v1-release-candidate-r11-20260913`, chưa tạo.
- Toàn bộ gói: manifest ngoài repo `r11-candidate-final-manifest.json`; hash runtime/migration riêng ở `r11-product-manifest.json`. Không dùng package-plan298 files ban đầu.
- Phạm vi: các sửa R01–R10 được tích hợp trên base hiện hành; bổ sung R11 chống pause salon bằng deadline cũ, quản lý thẻ theo bằng chứng bảo vệ, link đã dùng/hết hạn, màu form và tách trạng thái theo token. Giữ17 file Production mới nguyên byte.
- Inventory531 migration files;21 migration trong delta Git. Chưa biết có bao nhiêu migration thực sự cần áp dụng vào Production. Không chạy migration Production theo danh sách này.
- Không đưa credentials, capability links, DB dump, raw provider receipt hoặc evidence private lên GitHub/Vercel.

## Trình tự sau khi được Huy duyệt gói

1. Đọc lại remote branch và Production metadata. Nếu base đổi, ghép delta mới mà giữ code đang Live, chạy lại những kiểm tra bị ảnh hưởng và cập nhật manifest trước publish.
2. Kiểm tra GitHub/Vercel CI và env routing trước push: Preview tuyệt đối không dùng DB/provider/key Production. Nếu auto-Preview hiện tại không đáp ứng được, dùng môi trường QA/Preview riêng và giữ publish phụ thuộc đang chặn cho đến khi guard đúng; không tắt guard sản phẩm.
3. Kiểm tra history và catalog của Supabase QA disposable. Dựng QA riêng không chứa dữ liệu thật nếu branch dùng chung bị drift; giữ SMS/email/call và charge OFF, Square Sandbox, cron/provider sync OFF. Áp dụng schema chỉ sau source-guard/parity/ACL và restore rehearsal phù hợp. Không sao chép dữ liệu Production.
4. Tạo nhánh, commit đúng manifest, push nhánh riêng, mở draft PR và chạy CI. Trước upload kiểm lại diff không có secret/artifact private. Ghi SHA commit thực tế; base SHA không thay cho commit này.
5. Đưa đúng SHA lên Preview riêng. Chạy Computer Use cho ba flow cá nhân/nhóm/chuỗi, các role và tenant, thẻ success/decline/recovery, replay/race, consent, hủy/no-show thiếu receipt, link reload/hết hạn và theme/mobile. Ghi booking synthetic + receipt + screenshot theo từng case; mock và Sandbox phải phân biệt.
6. Báo CI/Preview PASS hoặc FAIL trên exact SHA, còn gì mở và phương án rollback. Chỉ xin duyệt merge/Production sau khi bằng chứng này đầy đủ và quyết định sản phẩm liên quan đã chốt.

## Draft PR title/body để xem trước

**Title:** Fix V1 booking authority, card protection truth, and stale payment-pause races

**Body:**

V1 booking and card-management flows could trust stale or insufficient authority: phone-bound incentives and customer identity were not consistently scoped, physical card presence could be presented as active protection without a durable receipt, and an expired grace snapshot could pause a salon after payment or extension. This candidate combines the reviewed fixes with the current Production base, retains current marketing changes, and preserves reserved appointments while card recovery reconciles uncertain provider outcomes without blind replay.

The new payment-pause RPC locks and rechecks the current deadline before changing salon flags and audit together. Card management displays active protection only when its authoritative saved receipt and booking metadata agree; incomplete cards retain recovery/removal access. Consumed or expired links show actionable guidance, and card forms follow the salon theme with state isolated per token.

Local validation:6,091 unit tests passed,65 skipped; Webpack build and sequential typecheck passed. Square Sandbox backend:8 passed,1 skipped, including real decline, loss/reconciliation and duplicate-request cases. Native Chrome exercised Square SDK success, decline and a fresh-card retry against the actual local API/database. Final read UI, receipt state and dark/light theme checks passed. Schema/ACL and payment-pause SQL/race/integration checks passed. Seven existing lint warnings remain; no lint errors. CI and hosted Preview are pending. No Production deployment or full-Masterplan certification is included.

## Cổng ngoài publish vẫn mở

REL-02 billing/access/grace và chuyển đổi hai salon Live; kiểm thử Google QA deferred; inventory758/784 theo từng ID; bằng chứng pilot3salon/7–14ngày. Lỗi IAB khởi tạo Square SDK vẫn chưa rõ nguyên nhân dù Chrome chạy được. API có thể trả503 khi dependency không sẵn sàng để không báo bảo vệ sai; không hứa loại bỏ mọi503.
