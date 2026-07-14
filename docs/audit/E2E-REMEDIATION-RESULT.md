# NailIQ — NHÓM 4: Kết quả xử lý E2E ↔ Production

**Ngày:** 2026-07-14 (UTC)
**Phê duyệt:** Huy — phạm vi giới hạn nghiêm ngặt ở các tài khoản có email kết thúc bằng `.test.invalid`.
**Ràng buộc tuyệt đối:** KHÔNG đụng `john.2***@gmail.com` hay bất kỳ tài khoản nào không thuộc `.test.invalid`. → **Đã tuân thủ.**
**Không hiển thị password, token, session hay secret ở bất kỳ đâu.**

---

## 1. TÓM TẮT

| Hạng mục | Kết quả |
|---|---|
| Tài khoản test bị thu hồi session | **5** (8 session + 8 refresh token → **0**) |
| Tài khoản test bị gỡ quyền quản trị | **2** (cả 2 role `founder` → `revoked_at` đã set) |
| Tài khoản test bị disable | **5** (`banned_until` = +100 năm → GoTrue từ chối đăng nhập) |
| Tài khoản test bị **xoá** | **0** — cố ý giữ lại (xem §3) |
| Salon fixture xử lý | **2** quarantine (`archived_at`), **0** xoá |
| Tài khoản người thật bị ảnh hưởng | **0** |
| Booking thật bị ảnh hưởng | **0** (4.787 booking — không đổi) |
| Lỗi 500 mới trên production | **0** |

---

## 2. TRƯỚC / SAU

| Kiểm tra | Trước | Sau | Kỳ vọng |
|---|---|---|---|
| Session sống của `.test.invalid` | **8** | **0** | 0 ✅ |
| Refresh token sống của `.test.invalid` | **8** | **0** | 0 ✅ |
| `.test.invalid` còn quyền superadmin | **2** (`founder`) | **0** | 0 ✅ |
| `.test.invalid` chưa bị disable | **5** | **0** | 0 ✅ |
| Salon `e2e-*` chưa quarantine | 2 | **0** | 0 ✅ |
| **Superadmin THẬT còn active** | **3** | **3** | 3 ✅ |
| **Tài khoản thật bị disable nhầm** | 0 | **0** | 0 ✅ |
| **Salon thật bị archive nhầm** | 0 | **0** | 0 ✅ |
| **Booking của salon thật** | 4.787 | **4.787** | không đổi ✅ |

**Bằng chứng tài khoản thật nguyên vẹn:** `thehuy***` vẫn 9 session, `john.2***` vẫn 1 session, `bepnho***` vẫn active — cả 3 vẫn `founder`, không bị ban.

---

## 3. VÌ SAO **DISABLE** CHỨ KHÔNG **XOÁ** TÀI KHOẢN

Anh cho phép xoá *"chỉ khi chắc chắn không có foreign key hoặc dữ liệu cần giữ để điều tra"*. Kiểm tra cho thấy:

- **Không có FK** nào từ `public.*` trỏ vào `auth.users` → xoá sẽ không phá quan hệ dữ liệu.
- **NHƯNG** `superadmin_audit_logs.actor_user_id` tham chiếu tới các user này. 4 hành động quản trị của chúng là **bằng chứng điều tra**. Xoá `auth.users` sẽ làm mất email/thời điểm tạo — tức mất khả năng truy nguyên sau này.

→ Chọn **disable + gỡ quyền + thu hồi session**, giữ nguyên hàng dữ liệu. Rủi ro thực tế bằng **0** (không đăng nhập được, không còn quyền, không còn session), mà vẫn giữ được dấu vết. **Đảo ngược được.**

Nếu anh muốn xoá hẳn, chỉ cần ra lệnh — đây là quyết định của anh, không phải của em.

---

## 4. CÁC BƯỚC ĐÃ THỰC HIỆN TRÊN PRODUCTION

Mọi câu lệnh **ràng buộc vào domain `.test.invalid`**, không dùng danh sách UUID rời — để không đời nào chạm nhầm người thật.

| # | Hành động | Ràng buộc |
|---|---|---|
| E1 | Snapshot + xác nhận tập mục tiêu | `WHERE email LIKE '%@nailiq.test.invalid'` → đúng 5, **0** người thật |
| E2a | `DELETE FROM auth.sessions` | subquery trên cùng điều kiện email |
| E2b | `UPDATE auth.refresh_tokens SET revoked = true` | như trên |
| E3 | `UPDATE superadmins SET revoked_at = now()` | như trên — **giữ hàng** để lưu vết |
| E4 | `UPDATE auth.users SET banned_until = now() + 100 years` | như trên |
| E5 | `UPDATE salons SET archived_at = now()` | `WHERE slug LIKE 'e2e-%'` |
| E6 | Ghi `superadmin_audit_logs` cho từng hành động | actor = Huy (người phê duyệt), reason nêu rõ bối cảnh |

### Xác minh salon fixture trước khi động vào
Salon `e2e-rc-mobile-*` có 5 booking. Đã kiểm tra kỹ trước khi quyết định:
- Số điện thoại **rỗng** (không phải khách thật).
- Tên: `RC Baseline`, `RC Conflict`, `RC Display App`, `Te2eGuest178…` — tên fixture.
- 5 booking tạo cách nhau **1,1 giây** → tốc độ máy.
- **0 trùng lặp** số điện thoại với bất kỳ khách nào của salon thật.
→ Thuần fixture. Vẫn chọn **quarantine chứ không xoá** (đảo ngược được).

---

## 5. ⚠️ HAI ĐIỀU TRUNG THỰC CẦN NÓI

### 5.1 Quarantine KHÔNG ẩn được trang booking công khai

`archived_at` là cờ soft-archive sẵn có của codebase. Nó lọc salon khỏi **sitemap**, **gift card**, **customer API** và policy RLS công khai. **Nhưng trang booking `/[slug]` vẫn trả 200.**

Đã kiểm chứng: `https://www.nailiq.ca/e2e-a11y-salon` → **200**.

Mức nguy hiểm: **thấp** (chỉ là dữ liệu giả, không PII). Nhưng **em không tuyên bố là "đã ẩn"** khi thực tế chưa. Muốn ẩn hẳn thì phải **xoá** salon — chờ anh quyết.

### 5.2 E2E VẪN đang ghi vào production cho tới khi PR được merge

Trong lúc xử lý, salon **`e2e-a11y-salon` xuất hiện lúc 01:58:59 UTC** — sau ảnh chụp đầu tiên. Do job E2E của CI vẫn đang chạy trên PR trước đó. Đây là **bằng chứng trực tiếp** rằng dòng chảy vẫn chưa bị chặn.

**Việc dọn dẹp hôm nay chỉ là dọn hậu quả. Chỉ khi PR `fix/e2e-production-containment` được merge thì nguyên nhân mới thật sự bị chặn.**

---

## 6. CODE ĐÃ SỬA (trong PR, **chưa merge**)

| File | Thay đổi |
|---|---|
| `e2e/helpers/guardProduction.ts` | **MỚI** — chặn theo **Supabase project ref** + hostname production + ref được pin. **Fail-closed.** Không dựa vào `NODE_ENV` (workflow chạy `next start` nên `NODE_ENV=production` một cách hợp lệ → tín hiệu vô dụng) |
| `e2e/helpers/globalSetup.ts` | **MỚI** — chạy guard **trước mọi worker**, nên không spec nào kịp tạo user/salon/staff/booking/role |
| `e2e/helpers/globalTeardown.ts` | **MỚI** — sweep in-process sau khi chạy xong (kể cả khi test fail/timeout) |
| `e2e/helpers/sweep.ts` | **MỚI** — xoá **chỉ** theo marker: user `e2e-*@nailiq.test.invalid`, salon slug `e2e-*`. Không dùng khoảng thời gian, không `%test%`. Idempotent |
| `scripts/e2e-sweep.ts` | **MỚI** — sweep độc lập cho workflow step `if: always()` |
| `e2e/helpers/superadmin.ts` | Password **ngẫu nhiên 32-byte mỗi lần chạy** (bỏ hằng số công khai); email `e2e-<uuid>@nailiq.test.invalid`; **role mặc định hạ từ `founder` → `readonly_analyst`**; gọi guard khi nạp module |
| `e2e/helpers/guardProduction.unit.spec.ts` | **MỚI** — 20 unit test cho guard |
| `playwright.config.ts` | Thêm `globalSetup` + `globalTeardown` + `testIgnore` cho `*.unit.spec.ts` |
| `vitest.config.ts` | Include `e2e/**/*.unit.spec.ts` |
| `.github/workflows/e2e.yml` | **Gỡ `SUPABASE_SERVICE_ROLE_KEY` production** khỏi cả job `e2e` lẫn `visual-tests` → đổi sang `TEST_SUPABASE_*`; thêm `E2E_EXPECTED_PROJECT_REF`; **pre-flight step gác toàn bộ job** — thiếu project test → **skip rõ ràng** (kèm `::warning::` + job summary giải thích), có key mà **không pin ref** → **fail cứng**; thêm step sweep **`if: always()`** |

### Một lần sửa lại — và vì sao đáng nói
Bản đầu của em cho workflow **rơi về chế độ "db-free"** khi thiếu project test. Nghe thì cẩn thận, nhưng **sai**: app **không boot nổi** nếu thiếu env Supabase, nên job chết ở `wait-on` với thông báo *"Server did not respond within 30s"* — một triệu chứng **không nói gì về nguyên nhân thật**, và là đúng loại lỗi khiến người mệt mỏi sẽ "sửa" bằng cách **nhét lại key production vào**.

Đã thay bằng **pre-flight gác cả job**: không có project test → skip toàn bộ, kèm cảnh báo nêu đích danh secret còn thiếu và nói rõ vì sao production không phải lựa chọn.

**Đã kiểm chứng trên chính CI của PR này:** 2 job E2E **pass trong 4–6 giây** (tức skip sạch), sweep báo `removed 0 auth user(s), 0 salon(s)`, và **không một hàng `e2e-*` nào được tạo thêm trên production**.

### Mật khẩu cũ = credential công khai
Giá trị cũ nằm trong repo **PUBLIC** từ commit `316a61f`. Không thể "xoá khỏi lịch sử" một cách đáng tin. Đã coi là **lộ vĩnh viễn** → mọi tài khoản từng dùng nó đã bị disable ở §4.

---

## 7. TEST ĐÃ CHẠY

| Test | Kết quả |
|---|---|
| **Unit test (vitest)** | ✅ **28/28 pass** (8 cũ + **20 mới cho guard**) |
| **TypeScript** | ✅ 0 lỗi |
| **Lint** | ✅ **84 errors / 101 warnings — bằng ĐÚNG baseline `main`**, không thêm lỗi nào |
| **Build** | ✅ pass |
| **🔥 Live-fire guard (quan trọng nhất)** | ✅ Chĩa **chính script xoá dữ liệu** vào production → **bị chặn đứng trước khi chạm 1 dòng**:<br>· URL = Supabase prod → `E2E write operations are forbidden against production… (ref: fshmobzyjhmtvndobwsy)`<br>· BASE_URL = `nailiq.ca` → `…The target host is a production host` |
| **Smoke production** | ✅ `/` 200 · `/tech-nails` 200 · `/hilite-anaheim` 200 · `/dashboard/tech-nails` → **307 → /login** · `/superadmin/salons` → **307 → /superadmin/login** |
| **E2E (Playwright)** | ❌ **Chưa chạy được** — cần Supabase test riêng (đó chính là việc PR này mở đường cho) |

---

## 8. LỖI 500 TRÊN PRODUCTION — ĐÁNH GIÁ TRUNG THỰC

Trong 45 phút gần nhất **CÓ 5 lỗi 500** trên `/api/booking/square-save-card`.

**Đây KHÔNG phải lỗi mới.** Error group này xuất hiện lần đầu **2026-06-14** (một tháng trước), tổng 11 lần: Square trả `400 INVALID_CARD_DATA (source_id)` → app ném 500.

Và trớ trêu thay, nó lại là **thêm một bằng chứng nữa** cho chính vấn đề đang xử lý: **E2E đẩy token thẻ giả vào Square API THẬT của production**. Sửa xong việc tách môi trường, lớp 500 này sẽ tự biến mất khỏi prod.

**Không có lớp lỗi mới nào xuất hiện sau khi xử lý.**

---

## 9. RỦI RO CÒN LẠI

| # | Rủi ro | Mức | Ghi chú |
|---|---|---|---|
| 1 | **E2E vẫn ghi vào prod cho tới khi PR merge** | 🔴 CAO | Đã chứng minh bằng `e2e-a11y-salon` lúc 01:58:59 |
| 2 | **Chưa có Supabase test project** | 🔴 CAO | Việc merge PR khiến E2E rơi về db-free → **mất coverage DB** cho tới khi anh dựng project test. Đây là đánh đổi có chủ ý: mất coverage tạm thời **tốt hơn** ghi vào DB khách hàng |
| 3 | Salon `e2e-*` vẫn truy cập được qua URL trực tiếp | 🟡 THẤP | Quarantine không ẩn `/[slug]`. Chờ anh quyết xoá |
| 4 | Service-role key production vẫn nằm trong GitHub secrets | 🟡 THẤP-TB | PR **không còn tham chiếu** nó, nhưng secret vẫn tồn tại. Chưa xoá (theo yêu cầu) |
| 5 | `job john.2***@gmail.com` có role `founder` | ⚠️ CẦN XÁC NHẬN | **Không phải** tài khoản test → không đụng. Anh xác nhận có chủ đích cấp quyền cao nhất cho người này không? |
| 6 | Rate-limit `card-save`, `booking-page-load` chưa cấu hình | 🟡 THẤP-TB | Log ghi `Rate-limit ID … not configured` → rate limit đang là **no-op**. Finding riêng |

---

## 10. KHẢ NĂNG ROLLBACK

| Hành động | Đảo ngược? | Cách |
|---|---|---|
| Thu hồi session/token của tài khoản test | ✅ | Đăng nhập lại (nhưng đã bị ban) |
| Gỡ quyền superadmin | ✅ | `UPDATE superadmins SET revoked_at = NULL` |
| Disable tài khoản | ✅ | `UPDATE auth.users SET banned_until = NULL` |
| Quarantine salon | ✅ | `UPDATE salons SET archived_at = NULL` |
| Code + workflow | ✅ | PR chưa merge — không revert gì cả |
| **Đã xoá gì chưa?** | — | **KHÔNG. Không xoá một hàng nào.** Toàn bộ xử lý là đảo ngược được |

---

## 11. VIỆC CẦN ANH QUYẾT

1. **Merge PR** `fix/e2e-production-containment` → chặn tận gốc. *(Em không merge.)*
2. **Dựng Supabase project test** + thêm secrets `TEST_SUPABASE_URL` / `TEST_SUPABASE_ANON_KEY` / `TEST_SUPABASE_SERVICE_ROLE_KEY` + var `TEST_SUPABASE_PROJECT_REF` → khôi phục coverage E2E.
3. **Quyết định xoá hẳn** 5 tài khoản test + 2 salon fixture (hiện chỉ disable/quarantine).
4. **Xác nhận** `john.2***@gmail.com` có được phép giữ role `founder` không.
5. **Cân nhắc** gỡ `SUPABASE_SERVICE_ROLE_KEY` (prod) khỏi GitHub Actions secrets — giờ không workflow nào dùng nó nữa.

---

## 12. XÁC NHẬN PHẠM VI

✅ Chỉ xử lý tài khoản có domain `.test.invalid` · ✅ **KHÔNG** đụng `john.2***@gmail.com` · ✅ **KHÔNG** đụng tài khoản/salon/booking thật · ✅ Không xoá dữ liệu (chỉ disable/quarantine — đảo ngược được) · ✅ Không merge · ✅ Không deploy · ✅ Không chạy migration · ✅ Không rotate service-role key · ✅ Mọi hành động production đều được ghi audit log.
