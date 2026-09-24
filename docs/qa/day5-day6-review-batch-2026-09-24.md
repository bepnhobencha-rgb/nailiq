# Ngày 5–6 — batch gửi review, chưa phát hành

Ngày kiểm tra: 24/09/2026, Vancouver.
Nhánh: `qa/day5-receptionist-20260924`.
Base: `f6bf087b9d6f4354c3742ee270ab6aaf78cc8d9d`; remote main vẫn cùng SHA
khi kiểm tra trước commit. Huy đã duyệt commit/push/PR/Preview; không merge
hoặc deploy Production.

## Phạm vi

- Receptionist: giữ đúng ngày sau refresh, KPI 30 phút, không gợi ý thợ đang
  phục vụ là rảnh, nhãn EN/VI, keyboard/focus của form và drawer.
- Owner: số tiền có nguồn rõ ràng và gồm dịch vụ phụ; cảnh báo ngày mai mở
  đúng ngày; tìm kiếm/phân trang khách có chống response cũ và phục hồi lỗi.
- Loyalty chỉ xem: giữ số/thẻ khi dashboard refresh, tải lại program/stats,
  không hiển thị thẻ khách trước sau khi đổi số, không mở khóa cộng/trừ điểm.
- Fixture synthetic real-Auth, hồi quy và báo cáo Ngày 5–6. Không migration,
  thay đổi quyền hoặc dữ liệu salon thật.

## Xác minh trước commit

- `npm run typecheck`: PASS.
- `npm run test:unit`: **851 files PASS, 6 skipped; 6.658 tests PASS,
  65 skipped**, 15,44 giây. Các ca skipped không được tính là đã kiểm chứng.
- `node --import tsx scripts/check-i18n.ts`: 0 errors, 13 warnings có sẵn.
- Lint toàn bộ file sửa: 0 errors, 3 warnings đã có ở base. Lệnh
  `npm run lint` ban đầu FAIL vì quét cả output build bị Git ignore ở
  `qa/waitlist-delivery/.next`; chạy ESLint toàn repo với
  `--ignore-pattern '**/.next/**'` đạt 0 errors, 39 warnings. Không sửa hoặc
  bỏ qua source để đạt PASS; CI sạch chạy lint trước build fixture.
- `node --test qa/day5/stream-abort-reproduction.cjs qa/day5/stream-request-correlation.test.cjs`:
  **5/5 PASS**. CJS là cần thiết cho Node preload và thứ tự đặt NODE_ENV trước
  khi load React; ngoại lệ lint chỉ bao quanh các import này, không tắt lint chung.
- Quét mẫu secret trên 69 file của batch trước thêm báo cáo này: không phát
  hiện mẫu JWT, Supabase secret key, live Stripe key, Resend key, GitHub token
  hoặc private key. Đây không phải bảo đảm tuyệt đối không có secret.
- Full app build và UI đã PASS ở checkpoint trước trên cùng source ứng dụng:
  [Ngày 5](masterplan-day-5-receptionist-2026-09-24.md),
  [Ngày 6](masterplan-day-6-owner-2026-09-24.md).
  Ngày 6 cuối: 30/30 UI/SSR, retries=0; Computer Use trên Mac có viewport
  iPhone. Không chạy lại toàn bộ browser matrix trong lượt xuất bản này.

## Chặn Preview không an toàn

Kiểm tra read-only Vercel xác nhận project `nailiq`, production branch `main`.
Nhánh mới chưa có bộ env QA riêng; một số env Preview mặc định dùng chung scope
với Production. Không suy đoán giá trị bên trong là QA.

Đặt `git.deploymentEnabled["qa/day5-receptionist-20260924"]=false` trước push
để không tự tạo deployment từ env chưa xác minh. Không đổi cổng `main`,
Production env, deployment protection hoặc provider. Cần cấu hình riêng nhánh
trỏ QA, khóa outbound/provider và xác minh trước manual Preview deploy.
Việc copy kín cấu hình QA cho nhánh này đang chờ Huy duyệt riêng.

## Giới hạn và rollback

- Chưa Preview-verified hoặc Production-verified cho batch này.
- Nghiệm thu tiếp tân/chủ mới trên iPhone vật lý vẫn mở. Không tuyên bố
  Ngày 5–6 hoặc Master Plan hoàn thành 100%.
- Stream-abort và vòng đời refresh token synthetic được ghi riêng trong báo
  cáo; không che log hoặc suy ra mọi lỗi Production đã được giải thích.
- Giữ PR Draft. Không gửi SMS/email/call, không payment/provider.
- Rollback: revert riêng commit batch sau review; không reset worktree,
  không cần rollback database vì không có migration.
