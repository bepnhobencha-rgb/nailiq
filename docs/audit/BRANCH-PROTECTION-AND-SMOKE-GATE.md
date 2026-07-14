# Branch Protection & Smoke Gate

**Bật ngày:** 2026-07-14 · **Loại:** Branch Protection Rule (repo chưa dùng Ruleset)

---

## 1. Cấu hình đang áp dụng cho `main`

| Thiết lập | Giá trị |
|---|---|
| **Required status checks** | `Smoke (required)` · `Build & Type Check` · `Security Audit` |
| Require branches to be **up to date** | ✅ bật (`strict`) |
| **Require a pull request** before merging | ✅ bật |
| Required approvals | **0** — xem §2 |
| Dismiss stale reviews | ✅ |
| **Require conversation resolution** | ✅ |
| **Enforce for administrators** | ✅ — **kể cả Huy cũng không bypass được** |
| Block **force pushes** | ✅ |
| Block **branch deletion** | ✅ |
| Push thẳng vào `main` | ❌ **cấm** |

### KHÔNG đặt required (cố ý)
`E2E (Playwright) — non-RC tests` · `E2E (Playwright) — receptionist-center` · `Visual Regression` · `i18n & Copy Check` · AI triage · artifact upload · cleanup · supabase stop

---

## 2. Vì sao **0 approval**

Repo này có **đúng 1 collaborator**. GitHub **không cho tự duyệt PR của chính mình**. Đặt `required_approving_review_count: 1` sẽ **khoá cứng mọi PR** — không ai merge được gì, mãi mãi.

Nên: **PR vẫn bắt buộc** (không push thẳng vào `main`, mọi thay đổi đều qua PR và qua CI), nhưng **không cần approval**. Khi có người thứ hai, nâng lên `1`.

---

## 3. Vì sao Full E2E **không** phải required

Suite có **200 test**, hiện **40 đỏ** (xem [`E2E-FIRST-FULL-RUN.md`](./E2E-FIRST-FULL-RUN.md)).

Đặt nó làm required **ngay bây giờ** = **khoá cứng mọi PR** cho tới khi dọn sạch 40 lỗi. Và điều đầu tiên ai cũng làm khi bị khoá là **học cách bypass**.

> **Một cổng bắt buộc mà người ta bypass còn tệ hơn không có cổng — vì nó trông giống như đang bảo vệ.**

Full E2E **vẫn chạy trên mọi PR**, vẫn **đỏ trung thực**, vẫn upload trace/screenshot/log. Nó **báo cáo**, chỉ là chưa **gác cửa**.

**Khi nào thì đưa vào required:** khi 40 lỗi về 0. Lúc đó tick thêm 2 job E2E vào danh sách required.

---

## 4. Smoke gate — nội dung

**8 test, ~6 phút.** Không `continue-on-error`. Không `|| true` trên bước chạy test.

Job tự dựng Supabase local (throwaway), chạy production guard, apply baseline, kiểm schema parity, seed, build app, rồi:

| # | Kiểm tra | Bảo vệ điều gì |
|---|---|---|
| 1 | Trang chủ **200** | Site sống |
| 2 | Salon active **200** + render đúng tên | Khách vào được tiệm |
| 3 | Slug lạ → **404 THẬT** | Soft-404 (PR #743) không tái diễn |
| 4 | `/dashboard` chưa login → `/login` | Auth gate |
| 5 | `/superadmin` chưa login → `/superadmin/login` | Auth gate |
| 6 | Slug `dashboard-*` **không** bị middleware cướp | Ranh giới route (PR #744) |
| 7 | Booking công khai qua phone gate → service → staff | Khách tới được picker |
| 8 | **Khách ĐẶT ĐƯỢC LỊCH — xác minh trong Postgres** | Luồng mà chủ tiệm trả tiền để có |

### Test #8 — vì sao nó không thể pass giả

Một booking smoke assert *"màn hình thành công đã hiện"* là **vô giá trị** — màn hình chỉ là màn hình. Test này **từ chối tin UI**:

- **Theo dõi network** → fail nếu bất kỳ request booking nào trả **4xx/5xx**
- **Đua** giữa `booking-success` và `Could not complete booking` → thấy cái nào **sản phẩm thật sự làm**
- **ĐỌC HÀNG RA TỪ POSTGRES**: đúng salon · đúng service · đúng thợ · đúng khách · giờ trong tương lai · status hợp lệ
- **Xoá đúng hàng** nó vừa tạo, theo `id`

**Không mock RPC.** SMS/email tắt ở tầng tiến trình (test **không bao giờ** được nhắn tin cho người lạ), nhưng booking đi qua **server action thật** và **RPC thật** vào **database thật**. Mock RPC là biến test thành cái gương.

> Đây chính là test đã **phát hiện sự cố CSP** ([`CSP-LOCAL-E2E-INCIDENT.md`](./CSP-LOCAL-E2E-INCIDENT.md)). **Cổng smoke lập công trước cả khi kịp xanh.**

---

## 5. ⚠️ Nếu CI hỏng và anh cần merge gấp

`enforce_admins` đang **bật** → **kể cả anh cũng không bypass được**. Đó là điều anh yêu cầu, và nó đúng.

Nhưng nếu một ngày CI hỏng vì lý do ngoài code (GitHub Actions sập, action bị deprecate…) và anh **thật sự** cần merge:

```bash
# TẮT tạm
gh api -X DELETE repos/bepnhobencha-rgb/nailiq/branches/main/protection/enforce_admins

# … merge …

# BẬT LẠI NGAY
gh api -X POST repos/bepnhobencha-rgb/nailiq/branches/main/protection/enforce_admins
```

**Bật lại ngay.** Một cái cổng tắt "tạm" là một cái cổng đã tắt.
