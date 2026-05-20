# Brief: Tinh chỉnh Nailiq cho MVP Launch

**Người yêu cầu:** Huy (founder)
**Ngày tạo:** 20/05/2026
**Mục tiêu chung:** Đưa Nailiq lên đúng triết lý sản phẩm "Simple UX trên mặt, AI xử lý bên dưới", sẵn sàng onboard 2 khách đầu trong tuần này và scale tiếp theo.

---

## 0. ĐỌC TRƯỚC KHI BẮT ĐẦU (BẮT BUỘC)

Trước khi viết bất kỳ dòng code nào, bạn PHẢI đọc các file sau theo thứ tự:

1. `CLAUDE.md` — toàn bộ project instructions, conventions, security rules
2. `PROJECT_BRAIN.md` (nếu có) — vision dài hạn
3. `current-focus.md` — trạng thái hiện tại
4. `CHANGELOG.md` — những gì đã ship gần đây
5. `decisions-log.md` — architectural decisions đã chốt
6. `docs/ARCHITECTURE_LOCK.md` và các file trong `docs/`

**Bỏ qua:** `README.md`, `ROADMAP.md`, `DECISIONS.md`, `PROMPTS_MASTER.md`, `TEST_PLAN.md` — đây là boilerplate, không phải source of truth.

---

## 1. TRIẾT LÝ SẢN PHẨM (đừng phá vỡ)

> **Simple UX trên mặt, AI xử lý bên dưới.**

User target: chủ tiệm nail người Việt tại Canada, **không tech-savvy**, chủ yếu dùng điện thoại. Mỗi quyết định UI phải hỏi:

1. **Simple?** User mới có hiểu ngay không, không cần đọc hướng dẫn?
2. **AI-driven?** Có chỗ nào AI có thể gợi ý/auto thay user config thủ công không?
3. **Necessary for MVP?** 2 khách đầu có thực sự cần feature này tuần này không?

Nếu trang/feature không thoả 2/3 tiêu chí → hoãn hoặc ẩn cho MVP.

---

## 2. CONSTRAINTS (DO NOT)

- **KHÔNG** thêm REST API routes — chỉ dùng server actions (đã có pattern trong `src/shared/*/`)
- **KHÔNG** thay đổi tech stack (Next 16, React 19, Supabase, Tailwind v4, Framer Motion)
- **KHÔNG** bypass `salon_members` membership checks trong server actions
- **KHÔNG** lưu secrets vào `localStorage`
- **KHÔNG** skip Zod / runtime validation trên user-supplied input
- **KHÔNG** deploy hoặc commit khi `npm run build` fail
- **KHÔNG** downgrade React 19 / Next 16
- **KHÔNG** refactor `ReceptionistCenter.tsx` (2032 dòng, rủi ro vỡ realtime — chỉ đụng khi PM yêu cầu)
- **KHÔNG** đụng `conflictCheck.ts` hoặc booking insert paths nếu không cần thiết
- **KHÔNG** tạo primitive UI mới — reuse `src/components/ui/` (10 primitives đã lock)
- **KHÔNG** tạo color/spacing/animation ngoài tokens trong `docs/`

---

## 3. PHASE 0 — Quick Wins (immediate, ~3-4 giờ)

### Task P0.1: Hide 25 ComingSoonPages khỏi sidebar Superadmin

**Mục tiêu:** Bạn (Huy) khi vào superadmin không còn thấy 25 link "Coming Soon" làm UI lộn xộn.

**Files cần đụng:**
- Tìm sidebar config superadmin: `src/components/superadmin/SuperAdminSidebar.tsx` hoặc tương tự
- 25 trang ẩn (giữ code, chỉ ẩn link):
  - `/superadmin/ai`, `/ai/costs`, `/ai/performance`, `/ai/prompts` (4)
  - `/superadmin/analytics`, `/analytics/churn`, `/analytics/platform`, `/analytics/revenue`, `/analytics/usage` (5)
  - `/superadmin/billing`, `/billing/mrr`, `/billing/overrides`, `/billing/subscriptions` (4)
  - `/superadmin/operations/incidents`, `/maintenance`, `/rollouts`, `/system-health` (4)
  - `/superadmin/security`, `/security/access`, `/security/device-logs`, `/security/risk` (4)
  - `/superadmin/support/live-access`, `/support/audit-logs` (2)
  - `/superadmin/settings`, `/superadmin/(shell)/operations/announcements`, `/feature-flags` (giữ 2 cái cuối nếu cần)

**Approach:** Comment-out hoặc thêm `disabled: true` flag trong sidebar config. Routes vẫn tồn tại, chỉ ẩn link.

**Acceptance:**
- Mở `/superadmin` → sidebar chỉ còn ~5-7 items (Dashboard, Salons, Support cơ bản, Operations announcements + feature-flags)
- Code 25 trang vẫn tồn tại không bị xoá
- `npm run build` pass

**Effort:** ~30 phút

---

### Task P0.2: Simplify Salon Settings Hub

**Mục tiêu:** Chủ tiệm vào Settings không bị ngộp với 7 panels.

**Files cần đụng:**
- `src/components/dashboard/SalonSettingsHub.tsx` (chính)

**Approach:**
- Giữ 5 panels: link sang 4 setup pages (Address, Hours, Services, Staff) + Pricing
- ẨN 3 panels khỏi default view: `DashboardModulesSettings`, `DashboardPresetSettings`, `AuditLogViewer`
- 3 panels ẩn có thể access qua URL `?advanced=true` hoặc qua superadmin (cho power users)
- `BrandColor` và `WalkinAutoAssign` giữ lại nhưng đặt dưới collapsible "Advanced"

**Acceptance:**
- Default Settings UI có 5 panels lớn, dễ scan
- Chủ tiệm mới vào không thấy AuditLog/Modules/Preset
- Vẫn truy cập được khi cần

**Effort:** ~1-1.5h

---

### Task P0.3: Seed 10-15 dịch vụ nail mặc định cho Setup Services

**Mục tiêu:** Khi salon mới vào Setup Services, đã có sẵn danh sách dịch vụ phổ biến để tick + chỉnh thay vì gõ từ đầu.

**Files cần đụng:**
- Tạo migration mới: `supabase/migrations/[timestamp]_seed_default_services.sql` (HOẶC dùng setup wizard prefill khi salon mới register)
- `src/components/dashboard/ServicesSetupPanel.tsx` — UI có chỗ user tick từ default list
- `src/shared/dashboard/setupActions.ts` — action `seedDefaultServicesForSalon(salonId)`

**Danh sách seed đề xuất** (giá CAD trung bình thị trường VN-Canada):
- Gel Manicure — 30 min — $35
- Regular Manicure — 25 min — $25
- Gel Pedicure — 45 min — $50
- Regular Pedicure — 35 min — $40
- Acrylic Full Set — 60 min — $55
- Acrylic Fill — 45 min — $40
- Dip Powder — 50 min — $50
- Gel Removal — 15 min — $10
- Acrylic Removal — 20 min — $15
- Nail Art (per nail) — 5 min — $5
- French Tips Add-on — 10 min — $10
- Pedicure Spa — 60 min — $65

**Approach:** Khi salon completes register → automatically seed 12 services on (chủ tiệm có thể edit/delete/add). HOẶC: trên ServicesSetupPanel show button "Thêm 12 dịch vụ phổ biến" cho salon có 0 services.

**Acceptance:**
- Salon mới register → vào Setup Services thấy 12 dịch vụ pre-filled
- Có thể edit/delete từng cái
- Có thể thêm dịch vụ custom

**Effort:** ~1-1.5h

---

### Task P0.4: Hours preset (Mon-Fri 9-7, Sat 10-5)

**Mục tiêu:** Setup Hours không bắt user gõ 7 ngày một cách thủ công.

**Files cần đụng:**
- `src/components/dashboard/HoursSetupPanel.tsx` (hoặc tên tương tự)

**Approach:** Thêm 3 preset buttons trên đầu form:
1. **"Tiệm chuẩn"** — Mon-Fri 9:00-19:00, Sat 10:00-17:00, Sun closed
2. **"Tuần 7 ngày"** — Mon-Sun 9:00-19:00
3. **"Tự chọn"** — clear all, user nhập từ đầu

User click preset → form tự fill, vẫn có thể chỉnh từng ngày sau đó.

**Acceptance:**
- 3 preset buttons hiển thị trên form Hours
- Click preset → 7 ngày được fill đúng
- User vẫn có thể override từng ngày

**Effort:** ~30-45 phút

---

### Task P0.5: Default "all staff do all services"

**Mục tiêu:** Setup Staff không bắt user tick 120 checkbox (6 staff × 20 services).

**Files cần đụng:**
- `src/components/dashboard/StaffSetupPanel.tsx`
- Logic hiển thị capability matrix

**Approach:** 
- Mặc định: khi tạo staff mới → capability = "tất cả services"
- Ẩn capability matrix khỏi UI mặc định
- Hiện link "Giới hạn dịch vụ cho thợ này" — click mới show matrix

**Acceptance:**
- Tạo staff mới → tự động có thể làm tất cả services
- UI sạch, không show matrix trừ khi user request
- Existing salons có data không bị break

**Effort:** ~45 phút

---

## 4. PHASE 1 — Pre-Onboard Simplifications (~4-6 giờ)

### Task P1.1: NoShow Protection → 1 toggle "Tự động nhắc khách"

**Mục tiêu:** Thay vì 5 toggles phức tạp, chỉ còn 1 toggle với smart defaults.

**Files cần đụng:**
- `src/components/dashboard/NoShowProtectionHub.tsx` (đơn giản hoá hoặc replace)
- `src/app/dashboard/[slug]/no-show-protection/page.tsx`
- Hoặc: ẨN trang riêng, chuyển 1 toggle vào Settings

**Approach (recommended):**
- Trong Salon Settings, thêm card "Tự động nhắc khách" với:
  - 1 toggle on/off (default: ON với smart defaults)
  - Khi ON: tự động bật 24h email reminder + 3h SMS reminder (đã có)
  - Link nhỏ "Tuỳ chỉnh nâng cao" → mở dropdown với các toggle chi tiết (deposit, waitlist, etc.) cho power users
- Trang `no-show-protection` ẨN khỏi sidebar cho MVP

**Acceptance:**
- Settings có 1 card "Tự động nhắc khách" với 1 toggle
- Toggle ON bật cả 2 reminder kênh
- Link "Tuỳ chỉnh nâng cao" mở details (collapsible)
- Trang riêng `/no-show-protection` không xuất hiện trong sidebar

**Effort:** ~2h

---

### Task P1.2: Hide Reviews link cho Free salons

**Mục tiêu:** 2 khách đầu là Free → không hiển thị link Reviews (Pro-only feature) trong sidebar để tránh upsell trông phiền.

**Files cần đụng:**
- Sidebar config salon dashboard (tìm component render sidebar)
- `src/shared/lib/subscriptionPlans.ts` (đã có gating logic)

**Approach:** 
```tsx
{salon.plan !== 'free' && <SidebarLink href="/reviews" ... />}
```

Trang vẫn truy cập được qua URL nếu user gõ tay.

**Acceptance:**
- Salon Free → sidebar không có "Reviews"
- Salon Pro/Premium → có "Reviews"

**Effort:** ~20 phút

---

### Task P1.3: Empty state cho Owner Dashboard

**Mục tiêu:** 2 khách đầu vừa onboard → 0 bookings → dashboard không trông trống rỗng.

**Files cần đụng:**
- `src/components/dashboard/SalonOwnerDashboard.tsx`

**Approach:** Khi `bookings.length === 0`:
- Hiển thị onboarding checklist card lớn: "Hoàn thiện setup tiệm" với 4 bước (Address ✓/✗, Hours ✓/✗, Services ✓/✗, Staff ✓/✗) — link đến từng setup page
- Sau khi setup xong nhưng vẫn 0 booking → empty state thân thiện: "Tiệm bạn sẵn sàng nhận khách! Chia sẻ link booking: [link]"
- Có nút "Sao chép link" + "Mở booking page" + "QR code"

**Acceptance:**
- Salon 0 booking → thấy onboarding/sharing empty state
- Salon có booking → thấy dashboard bình thường

**Effort:** ~1.5h

---

### Task P1.4: Smoke test e2e trên production

**Mục tiêu:** Confirm 47 Playwright specs vẫn pass sau các thay đổi P0+P1.

**Approach:**
```bash
npm run typecheck
npm run build
npm run test:e2e
```

**Acceptance:**
- All 47 specs pass
- No TypeScript errors
- Build successful

**Effort:** ~30 phút (đợi tests chạy)

---

## 5. PHASE 2 — AI Prefill Setup Wizard (KILLER FEATURE)

**Đây là feature align với triết lý "Simple UX + AI underneath" rõ nhất. Đầu tư đúng đắn 1-2 ngày → đây sẽ là điểm khác biệt với mọi booking software trên thị trường.**

### Task P2.1: Design spec (làm trước khi code)

**Mục tiêu:** Thống nhất UX flow + technical approach trước khi viết.

**Output:** Một file `docs/ai-prefill-wizard-spec.md` mô tả:
- User flow (3-4 màn hình)
- Input options: upload ảnh menu / paste link Instagram / paste link website
- AI provider: Claude Sonnet với Vision (đã có `@anthropic-ai/sdk` trong package)
- Output schema: JSON với services (name, price, duration), hours, address (nếu có)
- Error handling: AI accuracy < 70% → fallback manual
- Privacy: ảnh menu không lưu, chỉ pass qua AI

**Effort:** ~2h design

---

### Task P2.2: Build AI Prefill server action

**Files mới:**
- `src/shared/dashboard/aiPrefillSetupAction.ts`
- `src/shared/types/aiPrefill.ts`

**Approach:**
```typescript
// Server action
async function aiPrefillFromImage(imageBase64: string) {
  // Call Claude Sonnet with Vision
  // Prompt: "This is a nail salon menu. Extract services as JSON array..."
  // Parse + validate with Zod
  // Return ParsedServices[]
}
```

**Acceptance:**
- Action nhận image (multipart upload) hoặc URL
- Trả về list services với confidence score
- Có error handling: AI fail → trả mảng rỗng + error message

**Effort:** ~4-6h

---

### Task P2.3: Build UI Setup Wizard mới

**Files mới/đụng:**
- `src/app/dashboard/[slug]/setup/page.tsx` (entry point — thay đổi flow)
- `src/components/dashboard/AIPrefillUploadPanel.tsx` (mới)
- `src/components/dashboard/AIPrefillReviewPanel.tsx` (mới — show extracted services, user tick/edit)

**Approach UX flow:**
1. **Màn 1:** Welcome — 3 options: "Upload ảnh menu" / "Paste link Instagram/Facebook" / "Tự nhập"
2. **Màn 2:** AI processing (loading state — show progress)
3. **Màn 3:** Review — danh sách services AI extract được, user tick để confirm, edit từng cái nếu cần
4. **Màn 4:** Saved → next setup step (hours, staff, address)

**Acceptance:**
- User upload ảnh menu → trong 10-20 giây thấy list services đề xuất
- Có thể edit/delete/add trước khi confirm
- Confirm → services lưu vào DB như khi nhập tay
- Failure case có graceful fallback

**Effort:** ~6-8h

---

### Task P2.4: E2E test cho AI Prefill

**Files:**
- `e2e/setup-wizard-ai-prefill.spec.ts`

**Approach:**
- Mock AI response với fixture
- Test happy path: upload → review → save
- Test failure case: AI returns empty → manual fallback

**Effort:** ~2-3h

---

## 6. QUY TRÌNH LÀM VIỆC

Mỗi task hoàn thành theo thứ tự sau:

1. **Branch:** `git checkout -b refine/p0-1-hide-coming-soon` (đặt tên branch theo task)
2. **Code:** Implement task
3. **Typecheck:** `npm run typecheck` — pass
4. **Build:** `npm run build` — pass
5. **Test (cho task UX-affecting):** `npm run test:e2e` hoặc spec liên quan
6. **Manual smoke test:** Open app, verify visually
7. **Commit:** Conventional commit, ví dụ `feat(superadmin): hide coming-soon pages from sidebar`
8. **Push + PR draft:** Để Huy review

**KHÔNG** commit tất cả thay đổi trong 1 commit lớn — mỗi task 1 commit.

---

## 7. OUT OF SCOPE (KHÔNG đụng trong brief này)

- `ReceptionistCenter.tsx` (2032 dòng) — chỉ test với salon thật, không refactor
- Stripe Connect Express — Phase 2 sau launch (sẽ có brief riêng)
- AI receptionist / Voice AI — v2, sau launch
- Migration squashing — sau khi MVP stable
- Performance optimization — sau khi có user thật
- Cookie consent / GDPR — sau khi launch
- Tiếng Anh translation (i18n) — đã có infrastructure, không cần touch

---

## 8. KHI BỊ BLOCK

Nếu gặp 1 trong các tình huống sau → **STOP, hỏi Huy:**

- Pattern existing không match với yêu cầu → có thể đụng kiến trúc lock
- Test fail không rõ nguyên nhân → có thể là regression
- Cần đụng `conflictCheck.ts`, `salonTime.ts`, `phoneFormat.ts` — load-bearing modules
- Cần thêm dependency mới
- AI Prefill cần API key Claude → confirm với Huy về cost + setup
- Migration phức tạp với data existing

---

## 9. ƯU TIÊN THỰC HIỆN

**Tuần này (20-26/5):**
- Phase 0 toàn bộ (3-4h)
- Phase 1 toàn bộ (4-6h)
- Tổng: ~7-10h work, có thể chia 3-4 session

**Tuần sau (27/5+):**
- Phase 2 — AI Prefill Wizard (1-2 ngày)
- Onboard 2 khách đầu trong khi build Phase 2

---

## 10. DEFINITION OF DONE (cho toàn bộ brief)

Brief này coi là DONE khi:
- ✅ Tất cả task P0 và P1 đã commit và pushed
- ✅ `npm run build` pass
- ✅ `npm run test:e2e` pass (47 specs)
- ✅ Smoke test manual: register → setup → public booking → cancel → dashboard
- ✅ Phase 2 (AI Prefill) deployed và tested với ít nhất 1 ảnh menu thật
- ✅ Sidebar superadmin gọn còn ~5-7 items
- ✅ Settings salon gọn còn 5 panels
- ✅ Setup wizard có AI Prefill option

---

*Brief tạo ngày 20/05/2026 bởi trợ lý Claude, dựa trên UX audit 47 trang và yêu cầu của Huy về triết lý "Simple UX + AI underneath".*
