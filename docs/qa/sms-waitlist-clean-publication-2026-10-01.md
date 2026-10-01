# SMS/Waitlist — clean publication gates

01/10/2026. Code commit `adb9ff5607dd50d162eef8119263742e8aa1b891`.
Kiểm tra tại checkout sạch riêng, không sử dụng các thay đổi pilot/Square
còn dirty trong worktree nguồn. Chỉ SMS/Waitlist thuộc batch xuất bản.

## Kết quả local

- Full unit suite: **7,381 PASS / 227 skipped**, 887 files PASS / 10 skipped.
  Không tính các integration opt-in bị skip là PASS.
- Default `next build` (Turbopack): PASS, static pages 61/61; TypeScript PASS.
- Typecheck riêng, chạy tuần tự sau build: PASS.
- Source lint trước publication: 0 errors / 3 existing warnings.
- Database root local rỗng trước/sau từng gate. Không dotenv, không hosted
  credential; network fence chỉ cho loopback. Không provider hoặc thông báo.

## Giữ nguyên evidence chưa đạt

- B68 unit: 7,314 PASS / 67 FAIL / 227 skipped. Harness ép kill switches và
  Supabase URL local vào mọi unit test, làm sai môi trường của test mocked
  provider/CSP. B69 bỏ các biến này riêng cho unit, vẫn không credential thật
  và vẫn có network fence; toàn suite PASS. Không sửa app/test để che lỗi.
- B70 build: FAIL vì symlink node_modules trỏ ra ngoài filesystem root của
  Turbopack. Thay bằng bản dependency local trong checkout; B71 build PASS.
  Không đổi cấu hình bundler hoặc chuyển sang Webpack để né cổng build.
- Hook commit khớp 7 dòng synthetic fixture/UUID, tên biến hoặc SQL function.
  Đã đối chiếu từng dòng chính xác. Dùng ngoại lệ false-positive một commit
  được chính hook ghi hướng dẫn; không sửa/tắt hook hoặc Git config.

## Lệnh và artifact

Harness riêng `verify-clean.mjs` trong
`/private/tmp/nailiq-sms-waitlist-publish-lSILOf`, chế độ unit/build/typecheck:

```sh
node verify-clean.mjs unit b69
node verify-clean.mjs build b71
node verify-clean.mjs typecheck b72
```

Log write-once B68–B72 tại `/private/tmp/nailiq-current-main-combined-iBPOnd`;
giữ nguyên log FAIL. Command receipt publication và fingerprints ở cùng
thư mục, không chứa hosted credential. Dependency/tool fixture chỉ phục vụ
local verification, không được đưa vào Git.

## Phân tách nghiệm thu

Hosted QA migration + 16 SQL cases có báo cáo riêng. Các cổng ở đây là LOCAL,
chưa phải CI mới, Preview runtime, provider delivery, scheduler thật, thiết bị
vật lý hoặc pilot con người. Giữ PR #1441 Draft. Ngày 22 chưa đóng;
không merge/deploy Production và không đổi hai salon Live.
