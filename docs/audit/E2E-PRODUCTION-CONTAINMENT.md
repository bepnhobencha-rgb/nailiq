# NailIQ — NHÓM 3: E2E ↔ Production Containment

**Ngày:** 2026-07-14 (UTC)
**Chế độ (khi viết):** CHỈ ĐIỀU TRA + LẬP KẾ HOẠCH.
**Không hiển thị password, token, session hay secret ở bất kỳ đâu.**

> ## ✅ TRẠNG THÁI: ĐÃ XỬ LÝ (NHÓM 4, 2026-07-14)
>
> Kế hoạch trong tài liệu này **đã được Huy phê duyệt và thực thi**. Kết quả chi tiết: **[`E2E-REMEDIATION-RESULT.md`](./E2E-REMEDIATION-RESULT.md)**.
>
> Tóm tắt: 5 tài khoản `.test.invalid` đã bị **thu hồi session + gỡ quyền superadmin + disable**; salon fixture `e2e-*` đã **quarantine**; production guard + sweep `if: always()` + password ngẫu nhiên đã được viết và đưa vào PR `fix/e2e-production-containment`. **3 tài khoản quản trị thật không bị đụng tới.**
>
> Một phát hiện mới trong lúc xử lý: **E2E vẫn đang ghi vào production ngay trong lúc audit** — salon `e2e-a11y-salon` được CI tạo lúc 01:58:59 UTC, sau ảnh chụp đầu tiên. Việc này chỉ dừng hẳn khi PR nói trên được merge.

---

## 0. TÓM TẮT ĐIỀU HÀNH

Rủi ro **lớn hơn** những gì NHÓM 2 báo cáo, nhưng thiệt hại **nhỏ hơn** lo ngại ban đầu.

**Lớn hơn:**
- Không phải 2 mà là **5 tài khoản E2E** đang sống trong `auth.users` production (2 là superadmin `founder` active, 3 là auth-user mồ côi).
- Cả 5 đều **đăng nhập được bằng mật khẩu**, email đã xác thực, và **còn tổng cộng 8 session + 8 refresh token chưa thu hồi**.
- Có **3 salon E2E** trong DB production — **được tạo HÔM NAY (2026-07-14)**, tức E2E **vẫn đang ghi vào production ngay lúc này**.

**Nhỏ hơn:**
- **Không một dữ liệu thật nào bị chạm.** 4 hành động quản trị của 2 superadmin E2E đều nhắm vào **salon fixture đã bị xoá**, thực hiện trong **2–5 giây** sau khi tạo tài khoản — dấu vết máy chạy test, không phải người.
- 3 salon thật (Tech Nails 667 booking, Hi-Lite Head Spa 1048, Hi-Lite Studio 3072) **nguyên vẹn**.
- Service-role key **chưa hề bị lộ** (không có trong git, fork không đọc được, chỉ 1 collaborator).

**Nguyên nhân gốc (đã xác định chính xác):** cleanup nằm trong `test.afterAll()`, nhưng workflow đặt `concurrency: cancel-in-progress: true`. Khi một push/PR mới huỷ job E2E đang chạy giữa chừng, **`afterAll` không bao giờ chạy** → tài khoản và salon test ở lại vĩnh viễn trên production.

---

## 1. HAI (THỰC RA LÀ NĂM) TÀI KHOẢN E2E — ĐÃ XÁC MINH

### 1.1 Superadmin đang ACTIVE (ưu tiên xử lý cao nhất)

| # | User ID | Email (đã che) | Role | Active | Tạo lúc | Đăng nhập cuối | Session sống | Refresh token sống |
|---|---|---|---|---|---|---|---|---|
| A1 | `eb5e0a57-46dc-4359-944f-261932a6ad03` | `e2e-superadmin-178***@nailiq.test.invalid` | **founder** | ✅ | 2026-06-14 05:52:27 | 2026-06-14 05:52:28 | **1** | **1** |
| A2 | `2c3bbf9c-6f81-4524-a96f-e1c8c75e1d7f` | `e2e-superadmin-178***@nailiq.test.invalid` | **founder** | ✅ | 2026-06-14 22:47:15 | 2026-06-14 22:47:15 | **1** | **1** |

### 1.2 Auth-user mồ côi (không còn quyền superadmin, nhưng vẫn đăng nhập được)

| # | User ID (rút gọn) | Email (đã che) | Quyền | Tạo lúc | Session sống | Refresh token sống |
|---|---|---|---|---|---|---|
| A3 | `d55b3358…` | `e2e-superadmin-178***` | ❌ không còn superadmin | 2026-06-01 18:19:54 | **2** | **2** |
| A4 | `f3f3d100…` | `e2e-superadmin-178***` | ❌ không còn superadmin | 2026-06-01 18:23:45 | **2** | **2** |
| A5 | `739382fc…` | `e2e-superadmin-178***` | ❌ không còn superadmin | 2026-06-01 18:30:53 | **2** | **2** |

> A3–A5 là hậu quả của cleanup chạy **dở dang**: `cleanupTestSuperadmin()` xoá hàng `superadmins` trước, rồi mới xoá auth user — bị ngắt giữa chừng nên auth user còn lại.

### 1.3 Bằng chứng đây là tài khoản do TEST tạo

| Bằng chứng | Chi tiết |
|---|---|
| **Khớp mẫu seed chính xác** | Email khớp 100% `e2e-superadmin-${Date.now()}@nailiq.test.invalid` — đúng công thức tại `e2e/helpers/superadmin.ts:59` |
| **Domain không tồn tại** | `.test.invalid` là TLD dành riêng (RFC 2606) — không thể là email người thật |
| **Tốc độ máy** | Tạo → đăng nhập cách nhau **0,6–1,0 giây**. Con người không làm được |
| **Role mặc định** | `founder` — đúng giá trị default của `seedTestSuperadmin()` (dòng 61) |
| **Provider** | `email` (không phải OAuth) — đúng cách `auth.admin.createUser()` tạo |
| **`created_by` = NULL** | Không do superadmin nào mời — được tạo bằng service-role key |
| **Hành vi sau đó** | Chỉ `salon_flags_set` lên salon fixture, xong dừng — đúng kịch bản 2 spec test |

**Kết luận: chắc chắn 100% là tài khoản test. Không có tài khoản quản trị thật nào bị nhầm lẫn vào danh sách.**

### 1.4 Có dữ liệu thật liên quan không? Có hành động quản trị đáng ngờ không?

**KHÔNG — cả hai đều không.**

| Kiểm tra | Kết quả |
|---|---|
| `salon_members` (thành viên tiệm) | **0** — không tài khoản E2E nào thuộc tiệm nào |
| `staff` | **0** |
| Hành động quản trị đã ghi log | **4** (mỗi superadmin 2) — **tất cả** đều là `salon_flags_set` |
| Mục tiêu của 4 hành động | Salon `76cf5eb9…` và `bad96ca1…` — **không còn tồn tại** trong bảng `salons` (fixture đã bị xoá) |
| Thời điểm | 2–5 giây sau khi tạo tài khoản |
| Salon THẬT có bị chạm không | ❌ **KHÔNG.** Tech Nails / Hi-Lite Head Spa / Hi-Lite Studio: **0 hành động** |
| Booking / khách / thanh toán | ❌ Không hành động nào |

---

## 2. DỮ LIỆU TEST CÒN SÓT TRÊN PRODUCTION

`public.salons` có **6 hàng — 3 trong đó là fixture E2E**:

| Slug | Tên | Loại | Tạo ngày | Bookings | Staff | Services |
|---|---|---|---|---|---|---|
| `e2e-rc-mobile-29298115054` | E2E Receptionist Center | 🔴 **FIXTURE** | **2026-07-14** | 5 | 5 | 6 |
| `e2e-group-preclaim` | E2E Group Salon | 🔴 **FIXTURE** | **2026-07-14** | 0 | 3 | 3 |
| `e2e-group-otp` | E2E Group Salon | 🔴 **FIXTURE** | **2026-07-14** | 0 | 3 | 3 |
| `tech-nails` | Tech Nails Salon | ✅ THẬT | 2026-06-02 | **667** | 10 | 49 |
| `hilite-anaheim` | Hi-Lite Head Spa | ✅ THẬT | 2026-06-04 | **1048** | 10 | 12 |
| `hilite-studio` | Hi-Lite Studio | ✅ THẬT | 2026-06-22 | **3072** | 10 | 12 |

> ⚠️ **3 salon fixture được tạo NGÀY 2026-07-14** — chính là hôm nay, do CI chạy trên PR #740/#741. **Đây là bằng chứng E2E vẫn đang ghi vào DB production ở thời điểm hiện tại**, không phải chuyện quá khứ.

---

## 3. HARDCODED CREDENTIAL

| Câu hỏi | Trả lời |
|---|---|
| **Password mặc định hardcode ở đâu** | `e2e/helpers/superadmin.ts:60` — `const password = opts?.password ?? "********REDACTED";` |
| **Có trong Git history không** | ✅ **CÓ.** Đưa vào từ commit `316a61f` — *"test(superadmin): add platform flag audit coverage (#220)"*. Vẫn còn trên HEAD. **Repo là PUBLIC** → công khai vĩnh viễn |
| **Có dùng để tạo tài khoản production không** | ✅ **CÓ.** Cả 5 tài khoản ở §1 đều do `seedTestSuperadmin()` tạo bằng đúng giá trị mặc định này |
| **Tài khoản nào khác dùng cùng password** | Không thể kiểm chứng bằng mật mã (bcrypt có salt). **Nhưng theo đường code:** cả 5 tài khoản `e2e-superadmin-*` đều đi qua nhánh default → **giả định cả 5 dùng chung một mật khẩu**. 3 tài khoản quản trị thật dùng Google OAuth / mật khẩu riêng → **không liên quan** |
| **Session / refresh token còn sống không** | ✅ **CÓ.** Tổng **8 session + 8 refresh token chưa thu hồi** trên 5 tài khoản (A1,A2 mỗi cái 1; A3–A5 mỗi cái 2). Tồn tại từ 01/06 và 14/06 — tức **hơn 1 tháng** |
| **Nơi nào khác dùng helper này** | `e2e/superadmin/feature-flag-toggle.spec.ts`, `e2e/superadmin/salon-release-features.spec.ts` |

---

## 4. E2E ĐANG KẾT NỐI PRODUCTION — CƠ CHẾ CHÍNH XÁC

| Hạng mục | Thực tế |
|---|---|
| **Workflow** | `.github/workflows/e2e.yml` |
| **Jobs** | `i18n-check` → `e2e` (matrix 2 shard: *non-RC tests*, *receptionist-center*) → `visual-tests` (chỉ push main) → `ai-triage` (khi fail) |
| **Trigger** | `push: [main]` và `pull_request: [main]` |
| **`pull_request_target`?** | ❌ **KHÔNG dùng** → ✅ **PR từ fork KHÔNG đọc được secret**. Đây là cấu hình ĐÚNG |
| **Supabase URL test dùng** | `${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}` — trỏ vào **project production duy nhất** (`fshmobzyjhmtvndobwsy`). **Không có project test nào tồn tại** |
| **Service-role key** | `${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}` (dòng 69 job `e2e`, dòng 189 job `visual-tests`) — **key toàn quyền của production, bỏ qua toàn bộ RLS** |
| **Vì sao key prod có trong workflow** | Vì **không có DB test riêng**. Bước *"Decide which specs to run"* (dòng 129) cho thấy chủ ý: **có key → chạy full suite; không có key → chỉ chạy `e2e/content` + `e2e/accessibility` (db-free)**. Tức là key được đưa vào **để test có DB mà chạy** — và DB duy nhất là production |

### 4.1 Test nào tạo/sửa dữ liệu production

| Vùng | Ghi gì vào production |
|---|---|
| `e2e/superadmin/*` | **Tạo auth user + hàng `superadmins` role `founder`** → chính là 5 tài khoản ở §1. Bật/tắt feature flag của salon |
| `e2e/receptionist-center/*` | Tạo salon fixture + staff + services + **bookings** (5 booking trong `e2e-rc-mobile-*`) |
| `e2e/group-booking/*` | Tạo salon `e2e-group-otp`, `e2e-group-preclaim` + staff + services |
| `e2e/booking*.spec.ts`, `e2e/noshow-*` | Tạo/sửa booking, client profile |
| `e2e/register.spec.ts` | Tạo salon mới |

**Có xoá/sửa booking, customer, staff, salon không?** ✅ **CÓ** — `cleanupTestSalon()` chạy **XOÁ** salon + dữ liệu con. Hiện tại nó chỉ nhắm vào slug fixture, **chưa từng chạm salon thật** — nhưng nó là hàm **DELETE chạy bằng service-role key trên DB production**. Chỉ cần một lỗi ở biến slug là xoá nhầm.
**Payment:** không có test nào ghi payment thật (Stripe test mode).

### 4.2 Có cơ chế cleanup không — và vì sao vẫn sót

**CÓ**, nhưng **không đáng tin cậy**:
- `cleanupTestSuperadmin()` được gọi trong `test.afterAll()` (`feature-flag-toggle.spec.ts:73-76`, `salon-release-features.spec.ts:62-64, 141-143`).
- `seedReceptionistCenterFixture()` gọi `cleanupTestSalon()` **TRƯỚC khi seed** (dọn của lần trước), **không phải sau khi test xong**.

**🔑 NGUYÊN NHÂN GỐC:** workflow đặt

```yaml
concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true      # ← thủ phạm
```

Khi một commit/PR mới huỷ job E2E đang chạy giữa chừng, tiến trình Playwright **bị kill** → **`afterAll` không bao giờ chạy** → tài khoản + salon ở lại production vĩnh viễn. Đây chính xác là cách 5 tài khoản và 3 salon còn sót.

### 4.3 Fork / PR có đọc được secret không

| Đối tượng | Đọc được secret? |
|---|---|
| PR từ **fork** (người ngoài) | ❌ **KHÔNG** — GitHub không cấp secret cho `pull_request` từ fork |
| PR từ **nhánh trong repo** | ✅ Có — nhưng repo chỉ có **1 collaborator: `bepnhobencha-rgb`** (chính Huy, quyền admin) |
| Người ngoài bất kỳ | ❌ Không |

---

## 5. THIẾT KẾ BIỆN PHÁP CHẶN (đã soạn — **CHƯA áp dụng**)

### 5.1 Guard chặn production — file MỚI `e2e/helpers/guardProduction.ts`

Không dựa vào `NODE_ENV` (workflow chạy `next start` → `NODE_ENV=production` một cách hợp lệ, nên `NODE_ENV` là tín hiệu vô dụng ở đây). Thay vào đó **khoá theo project ref của Supabase**:

```ts
// e2e/helpers/guardProduction.ts
const PROD_PROJECT_REFS = ["fshmobzyjhmtvndobwsy"];      // Supabase production
const PROD_HOST_PATTERNS = [/(^|\.)nailiq\.ca$/i];        // domain production

function projectRefFrom(url: string): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

export function assertNotProduction(): void {
  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const base = process.env.PLAYWRIGHT_BASE_URL ?? process.env.BASE_URL ?? "";
  const ref  = projectRefFrom(url);

  if (ref && PROD_PROJECT_REFS.includes(ref)) {
    throw new Error(
      `E2E is forbidden against production. NEXT_PUBLIC_SUPABASE_URL points at the production project (${ref}). ` +
      `Point it at a dedicated test Supabase project.`,
    );
  }
  if (base && PROD_HOST_PATTERNS.some((re) => re.test(new URL(base).hostname))) {
    throw new Error(`E2E is forbidden against production. BASE_URL points at ${base}.`);
  }
  // Fail CLOSED: an unrecognised/absent ref must not silently pass.
  const expected = process.env.E2E_EXPECTED_PROJECT_REF;
  if (expected && ref !== expected) {
    throw new Error(`E2E project ref mismatch: expected ${expected}, got ${ref ?? "(none)"}.`);
  }
  if (!ref && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("E2E has a service-role key but an unrecognised Supabase URL — refusing to run.");
  }
}
```

**Fail-closed:** có service-role key nhưng URL không nhận diện được → **từ chối chạy**, thay vì đoán mò.

### 5.2 Gọi guard ở `globalSetup` — `playwright.config.ts`

```ts
export default defineConfig({
  globalSetup: "./e2e/helpers/globalSetup.ts",   // gọi assertNotProduction() → chặn TOÀN BỘ suite
  ...
});
```
Đặt ở `globalSetup` (không phải trong từng spec) để **không spec nào chạy được** nếu môi trường sai.

### 5.3 Sửa `e2e/helpers/superadmin.ts`

```ts
import { randomUUID } from "node:crypto";

export const E2E_PREFIX = "e2e-";                       // prefix rõ ràng, bắt buộc

export async function seedTestSuperadmin(opts?: {...}) {
  assertNotProduction();                                // chặn lần 2, ngay tại điểm ghi
  const email    = opts?.email ?? `${E2E_PREFIX}superadmin-${randomUUID()}@nailiq.test.invalid`;
  const password = opts?.password ?? `E2E-${randomUUID()}`;   // ⬅ NGẪU NHIÊN mỗi lần chạy
  const role     = opts?.role ?? "support";             // ⬅ KHÔNG mặc định 'founder'
  ...
}
```
- Password **ngẫu nhiên mỗi lần** → không còn credential công khai.
- Role mặc định **hạ xuống mức thấp nhất**; spec nào cần `founder` phải khai báo tường minh.
- Không cho tạo superadmin nếu guard thấy production.

### 5.4 Cleanup chống-bị-kill

`afterAll` không đủ (bị kill là mất). Thêm 2 lớp:
1. **Bước "sweep" trong workflow** với `if: always()` — xoá mọi `e2e-*` user/salon sau khi job kết thúc, kể cả khi bị huỷ.
2. **Sweep đầu mỗi lần chạy** (`globalSetup`) — dọn rác của lần trước.
3. Cân nhắc bỏ `cancel-in-progress: true` cho job E2E, hoặc chấp nhận và dựa vào sweep.

### 5.5 Sửa `.github/workflows/e2e.yml`

```yaml
env:
  NEXT_PUBLIC_SUPABASE_URL:  ${{ secrets.TEST_SUPABASE_URL }}          # ⬅ project TEST
  NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.TEST_SUPABASE_ANON_KEY }}
  SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}
  E2E_EXPECTED_PROJECT_REF:  ${{ vars.TEST_SUPABASE_PROJECT_REF }}
```
→ **Xoá hẳn `SUPABASE_SERVICE_ROLE_KEY` (prod) khỏi GitHub Actions secrets.**

> 💡 **Đòn bẩy chặn ngay lập tức:** logic sẵn có ở dòng 129 (*"Decide which specs to run"*) đã hỗ trợ điều này — **gỡ secret `SUPABASE_SERVICE_ROLE_KEY` là E2E tự động rơi về chế độ `db-free`** (chỉ chạy `content` + `accessibility`), **không ghi gì vào DB nữa**. Đây là cách chặn nhanh nhất, không cần sửa một dòng code nào.

### 5.6 Danh sách file dự kiến sửa

| File | Thay đổi |
|---|---|
| `e2e/helpers/guardProduction.ts` | **MỚI** — guard theo project-ref, fail-closed |
| `e2e/helpers/globalSetup.ts` | **MỚI** — gọi guard + sweep rác lần trước |
| `playwright.config.ts` | Thêm `globalSetup` |
| `e2e/helpers/superadmin.ts` | Password ngẫu nhiên, role mặc định thấp, gọi guard |
| `e2e/helpers/*` (seed salon/booking) | Gọi guard trước mọi thao tác ghi |
| `.github/workflows/e2e.yml` | Đổi sang secret của project test; thêm bước sweep `if: always()` |

---

## 6. KẾ HOẠCH THU HỒI TÀI KHOẢN (**chờ Huy phê duyệt**)

Thực hiện đúng thứ tự. Mỗi bước có kiểm chứng.

| Bước | Hành động | Đối tượng | An toàn |
|---|---|---|---|
| **0** | Chụp lại trạng thái trước khi sửa (`SELECT` lưu ra file) | 5 tài khoản + 3 salon | Để rollback/đối chiếu |
| **1** | Xác nhận đúng đối tượng: **chỉ** user có email khớp `e2e-superadmin-%@nailiq.test.invalid` | 5 user ở §1 | Điều kiện WHERE bám email pattern + `.test.invalid`, **không** dùng danh sách UUID rời |
| **2** | Đọc lại audit history lần cuối | 4 hành động | Đã xác nhận: 0 tác động thật |
| **3** | **Thu hồi toàn bộ session + refresh token** | 8 session, 8 token | Cắt đường vào **trước** khi làm gì khác |
| **4** | **Gỡ quyền superadmin**: `UPDATE superadmins SET revoked_at = now()` cho A1, A2 | 2 hàng | Giữ hàng để lưu vết audit — **không xoá** |
| **5** | **Xoá auth user** cả 5 (`auth.admin.deleteUser`) | A1–A5 | Không có FK sang dữ liệu thật (đã kiểm: `salon_members`=0, `staff`=0) |
| **6** | Xoá 3 salon fixture `e2e-*` + dữ liệu con | 3 salon | Bám `slug ILIKE 'e2e-%'`. **Tuyệt đối không đụng** `tech-nails`, `hilite-anaheim`, `hilite-studio` |
| **7** | Ghi audit log cho chính hành động xử lý này | `superadmin_audit_logs` | Có dấu vết ai dọn, lúc nào, vì sao |
| **8** | **Xác minh lại**: đếm lại superadmin (kỳ vọng **3**, đều là người thật), `auth.users` khớp `e2e-%` (kỳ vọng **0**), salon (kỳ vọng **3**, đều thật), session E2E (kỳ vọng **0**) | — | Bằng chứng đã sạch |

**Bảo vệ tài khoản quản trị thật:** 3 superadmin thật (`john.2***@gmail.com`, `thehuy***@gmail.com`, `bepnho***@gmail.com`) **KHÔNG nằm trong mọi điều kiện WHERE** — bộ lọc bám chặt vào domain `.test.invalid`, thứ mà người thật không thể có.

> ⚠️ **Một câu hỏi cần Huy xác nhận (ngoài phạm vi E2E):** superadmin `john.2***@gmail.com` có role **`founder`** (toàn quyền, đăng nhập gần nhất 2026-06-22). Đây **không phải** tài khoản test. Anh có chủ đích cấp quyền founder cho người này không? Nếu không → cần xử lý riêng.

---

## 7. ĐÁNH GIÁ ROTATE SUPABASE SERVICE-ROLE KEY

| Câu hỏi | Trả lời | Bằng chứng |
|---|---|---|
| Key có trong Git log không | ❌ **KHÔNG** | Quét 1554 commit, mọi ref — không có JWT/`sb_secret_`/`sbp_` nào |
| Key có bị lộ ra log GitHub Actions không | ❌ Không có dấu hiệu | GitHub tự động che secret trong log. Không có bước nào `echo` nó |
| PR từ fork đọc được key không | ❌ **KHÔNG** | Trigger là `pull_request`, **không phải** `pull_request_target` |
| Artifact/screenshot/output có chứa key không | ❌ Rủi ro thấp | Artifact = `playwright-report/` (trace/video/ảnh của trình duyệt). Service-role key chỉ dùng **server-side**, không xuất hiện trong request của browser. **Nên rà 1 lần cho chắc** |
| Có dấu hiệu sử dụng trái phép không | ❌ Không tìm thấy | Mọi ghi bất thường đều truy được về E2E. Dữ liệu thật nguyên vẹn. *(Nên đối chiếu thêm Supabase Auth logs để chắc chắn)* |
| Ai có thể rút key | Chỉ **1 collaborator**: `bepnhobencha-rgb` (chính Huy) | `gh api .../collaborators` |
| **Có cần rotate NGAY không** | 🟡 **KHÔNG khẩn cấp** | Key chưa lộ. **Nhưng nên rotate như một phần của việc tách môi trường** (§5.5) — vì key prod sẽ bị gỡ khỏi CI, nhân tiện đổi luôn là sạch sẽ nhất |

**Chưa rotate trong nhóm này.**

---

## 8. KHẢ NĂNG ROLLBACK

| Hành động | Đảo ngược được? | Cách |
|---|---|---|
| Thu hồi session/token | ✅ Dễ | Tài khoản E2E đăng nhập lại được (nhưng ta sẽ xoá luôn) |
| `revoked_at = now()` trên superadmin | ✅ Dễ | Set lại `NULL` |
| Xoá auth user E2E | ⚠️ **Không đảo ngược** | Nhưng **không mất gì**: không FK sang dữ liệu thật, không dữ liệu người dùng. Có snapshot ở bước 0 |
| Xoá 3 salon fixture E2E | ⚠️ **Không đảo ngược** | Chỉ là dữ liệu test (5 booking giả trong 1 salon). Có snapshot ở bước 0 |
| Sửa code E2E + workflow | ✅ Dễ | PR bình thường, revert được |
| Gỡ secret prod khỏi CI | ✅ Dễ | Thêm lại được. **Tác dụng phụ có lợi:** E2E rơi về chế độ db-free, ngừng ghi vào production |

**Rủi ro tổng thể của kế hoạch: THẤP.** Không có thao tác nào chạm dữ liệu thật.

---

## 9. XÁC NHẬN PHẠM VI

✅ Không xoá tài khoản · ✅ Không sửa database · ✅ Không rotate key · ✅ Không sửa code · ✅ Không commit · ✅ Không merge · ✅ Không deploy · ✅ Không đổi Vercel/env · ✅ Mọi truy vấn DB là `SELECT` read-only · ✅ Không hiển thị password/token/session/secret.

File duy nhất được ghi: chính file này. **Chưa commit. Đang chờ phê duyệt.**
