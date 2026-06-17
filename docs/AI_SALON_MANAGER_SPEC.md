# AI Salon Manager — SPEC v3

> **Trạng thái:** DRAFT — chờ Huy duyệt trước khi build P0.
> **Ngày:** 2026-06-16.
> **Thay thế:** SPEC v2 hoàn toàn.
> **Đã đọc:** `ARCHITECTURE_LOCK`, `ARCHITECTURE_OVERVIEW`, `UX_PRINCIPLES`, code 5 agent hiện tại.

---

## 1. Tầm nhìn & triết lý

### "Hoàn toàn tự động" — không phải "hầu như tự động"

**OLD model (SPEC v2):** AI gợi ý → người duyệt → hành động xảy ra.
**NEW model (v3):** AI hành động → thông báo owner → owner có thể undo.

Tiệm vận hành không cần owner giám sát liên tục. Owner can thiệp để **dừng**, không phải để **khởi động**. Đây là shift triết lý cốt lõi — mọi quyết định kiến trúc bên dưới phục vụ nguyên tắc này.

### Ba mức tự động hoá

| Mức | Tên | Nghĩa | Ví dụ |
|---|---|---|---|
| **AUTO** | Tự làm hoàn toàn | AI thực thi, ghi log, không chờ ai | Gửi SMS nhắc lịch, gắn cờ no-show, gửi tin win-back |
| **ACT+UNDO** | Làm rồi báo, có thể huỷ | AI thực thi ngay + mở undo window 60 phút | Gửi tin win-back, đề xuất flash deal nhỏ |
| **ESCALATE** | Chờ owner quyết | AI soạn nháp + thông báo, KHÔNG tự làm | Charge thẻ, đổi giá, review 1-3 sao, thay đổi cơ cấu dịch vụ |

**Quy tắc cứng:**
- **Tiền di chuyển** (charge thẻ, hoàn tiền, đổi giá) = luôn ESCALATE, không bao giờ AUTO.
- **Tin nhắn trực tiếp tới khách** = AUTO cho nhắc lịch/rebook/win-back; ESCALATE cho phản hồi review xấu.
- **Cấu hình tiệm** (giá, dịch vụ, giờ mở cửa) = luôn ESCALATE.

### Undo window

Mọi action ACT+UNDO được ghi vào `ai_actions_log` với `undo_deadline = now() + 60 min`. Owner nhận thông báo ngay. Trong 60 phút, nút "Undo" hiện trong ActivityFeed. Sau khi hết hạn, action là final.

---

## 2. Manager Briefing — Buổi giao việc đầu tiên

Thay vì 50 ô form, owner mới trò chuyện với AI khoảng 5-7 phút. AI hỏi — owner trả lời bằng tiếng Anh hoặc tiếng Việt tự nhiên — AI rút ra config có cấu trúc.

**Route:** `/dashboard/[slug]/setup/manager-briefing`

### Bộ câu hỏi (7 câu, theo thứ tự)

1. **Giới thiệu tiệm** — "Tiệm bạn làm dịch vụ gì? Ở đâu? Bao nhiêu nhân viên?"
   *(→ rút: `vertical`, `location`, `team_size`)*

2. **Khách hàng chính** — "Khách hàng chủ yếu của bạn là ai? Họ nói tiếng gì?"
   *(→ rút: `language_primary`, `language_secondary`, `customer_demographic`)*

3. **Vấn đề no-show** — "No-show có phải vấn đề lớn với tiệm không? Bạn đang xử lý thế nào?"
   *(→ rút: `noshow_strictness`: lenient/moderate/strict)*

4. **Liên lạc với khách** — "Bạn muốn liên hệ khách bao thường? Có giờ nào không nên nhắn không?"
   *(→ rút: `contact_window`, `winback_cadence`)*

5. **Tính cách thương hiệu** — "Nếu tiệm là một người, họ nói chuyện thế nào — ấm áp hay chuyên nghiệp? Thoải mái hay lịch sự?"
   *(→ rút: `brand_voice`, `tone_examples`)*

6. **Mục tiêu kinh doanh** — "Hiện tại bạn ưu tiên gì nhất — giữ khách cũ, kéo khách mới, hay tăng doanh thu?"
   *(→ rút: `primary_goal`)*

7. **Ranh giới tự động** — "AI được làm gì không cần hỏi bạn? Có thứ gì bạn muốn luôn kiểm soát không?"
   *(→ rút: `auto_approve[]`, `escalate[]`)*

**Flow UI:**
```
Owner types → Server Action (Sonnet) extracts structured SIP draft →
Show SIP review card → Owner edits fields inline → Confirm →
salons.ai_profile = SIP → "AI Manager của bạn đã sẵn sàng" summary screen
```

**Model:** `claude-sonnet-4-5` (không dùng Haiku — đây là setup một lần, cần chất lượng cao).
Có thể re-run bất kỳ lúc nào từ `/dashboard/[slug]/settings` mục "AI Manager".

---

## 3. Salon Intelligence Profile (SIP)

JSON object lưu tại `salons.ai_profile` (cột jsonb mới). Tất cả 9 agent đọc SIP trước khi hành động. SIP thay thế cho hardcode trong từng agent (hiện đang hardcode `"en"` cho language, hardcode strictness thresholds, v.v.).

### Schema

```typescript
type SalonIntelligenceProfile = {
  // Danh tính tiệm
  vertical: "nail" | "head_spa" | "massage" | "facial" | "waxing" | "multi";
  brand_voice: "warm_casual" | "warm_professional" | "luxury_formal" | "friendly_fun";
  language_primary: "en" | "vi" | "zh" | "ko";
  language_secondary?: "en" | "vi" | "zh" | "ko";
  customer_demographic: string; // free text, used verbatim in prompts

  // Tính cách hoạt động
  noshow_strictness: "lenient" | "moderate" | "strict";
  contact_window: string; // e.g. "9:00-20:00 America/Los_Angeles"
  winback_cadence: "gentle" | "normal" | "aggressive"; // gentle=60d, normal=45d, aggressive=30d
  primary_goal: "retain_regulars" | "attract_new" | "maximize_revenue";

  // Ranh giới tự động
  auto_approve: string[]; // e.g. ["send_reminders", "send_winback", "post_social_draft"]
  escalate: string[];     // e.g. ["charge_card", "change_price", "review_response_bad"]

  // Ví dụ giọng điệu (owner đã duyệt — dùng trong few-shot prompts)
  tone_examples: string[]; // 2-3 tin nhắn mẫu owner thích

  // Metadata
  built_at: string; // ISO timestamp
  built_via: "manager_briefing" | "settings_change" | "weekly_eval";
};
```

**SIP cập nhật khi:** Manager Briefing hoàn tất, owner đổi settings liên quan, Chiến Lược Gia weekly eval phát hiện drift.

**SIP builder** (`src/shared/ai/buildSip.ts`): đọc `salons` + `services` + `feature_flags` + `booking stats` 30d → gọi Sonnet → trả `SalonIntelligenceProfile` → write `salons.ai_profile`.

---

## 4. Bộ 9 Agent — chi tiết đầy đủ

### 4.1 🚪 Người Gác Cửa (No-show Protection)

**File:** `src/shared/noshow/agentNoShowPolicy.ts` (đã có — cần mở rộng)
**Trigger:** Mọi booking mới trên MỌI kênh (online/voice/desk/group/wix)
**Mức tự động:** AUTO
**Model:** `claude-haiku-4-5` (per-booking, volume cao)

**Làm gì:**
1. Đọc SIP: `noshow_strictness`, `language_primary`, `brand_voice`
2. Quyết protection level: `none` | `card` | `deposit`
3. Soạn tin yêu cầu (ngôn ngữ từ SIP, không hardcode `"en"`)
4. Ghi `ai_policy_decisions`, gắn cờ `bookings.noshow_card_required`

**Gap cần fix:**
- Hiện tại chỉ chạy cho `submitPublicBooking`. Cần bọc thành `handleBookingProtection(bookingId, channel)` và đấu vào: `api/voice/tool`, `receptionistActions`, group booking, quick-rebook.
- Language hardcode `"en"` trong prompt → thay bằng `sip.language_primary`.
- Channel field trong `PolicyContext` hiện không dùng → dùng để điều chỉnh strictness (desk = lower risk vì staff present).

**Input/Output:**
- Input: `PolicyContext` (đã có) + `SalonIntelligenceProfile`
- Output: `AiPolicyDecision` → `ai_policy_decisions` table

**DB tables:** `ai_policy_decisions`, `bookings` (flag)
**SIP fields:** `noshow_strictness`, `language_primary`, `brand_voice`

**Failure mode:** Agent down → fallback về luật cứng `noShowCardDecision()` (đã có, không thay đổi).

---

### 4.2 🔔 Người Nhắc Hẹn (Appointment Reminder)

**File:** `src/shared/reminders/agentSmartReminder.ts` (đã có — cần thêm SIP)
**Trigger:** Cron `/api/cron/reminders` (chạy `*/15 * * * *` — đã có)
**Mức tự động:** AUTO
**Model:** `claude-haiku-4-5`

**Làm gì:**
1. 24h trước: SMS + email nhắc lịch (đã có)
2. 2h trước: SMS nhắc thêm (đã có)
3. **Mới — Rebook reminder:** khi khách đến hạn theo cadence của họ mà chưa đặt → gửi "Đến lúc ghé tiệm rồi?" (logic từ `agentRebook.ts`)
4. Giọng điệu từ SIP `brand_voice`, ngôn ngữ từ SIP `language_primary`

**Gap cần fix:**
- Hiện `draftReminderLead` nhận `lang: "en" | "vi"` hardcode từ caller → cần đọc từ SIP.
- Rebook reminder (`agentRebook.ts`) đang ghi `winback_suggestions` status `suggested` nhưng chưa tự gửi → P3 sẽ auto-send.

**DB tables:** `booking_notifications`, `winback_suggestions`
**SIP fields:** `brand_voice`, `language_primary`, `contact_window`

---

### 4.3 💌 Người Kéo Về (Win-back)

**File:** `src/shared/winback/agentWinback.ts` (đã có — cần ACT+UNDO)
**Trigger:** Cron `/api/cron/manager` (mới, P1) — mỗi ngày 10:00 sáng giờ tiệm
**Mức tự động:** ACT+UNDO (60 phút)
**Model:** `claude-haiku-4-5`

**Làm gì:**
1. Tìm khách lapsed theo `winback_cadence` từ SIP (gentle=60d, normal=45d, aggressive=30d)
2. AI soạn tin cá nhân hoá (tên khách, dịch vụ hay làm, thời gian vắng)
3. **AUTO gửi** qua SMS/email (không chờ owner duyệt)
4. Ghi `ai_actions_log` với `undo_deadline = now() + 60min`
5. Push notification tới owner: "Đã gửi 3 tin win-back. Undo trong 60 phút nếu muốn."

**Gap cần fix:**
- Hiện tại chỉ ghi `winback_suggestions` status `suggested` — không bao giờ gửi (vòng lặp không khép). **P3** sẽ thêm auto-send.
- Language hardcode — thay bằng SIP.
- Cron gắn với `square-sync` → tách sang `/api/cron/manager` (P1).

**DB tables:** `winback_suggestions`, `ai_actions_log`, `booking_notifications`
**SIP fields:** `winback_cadence`, `language_primary`, `brand_voice`, `contact_window`, `tone_examples`

---

### 4.4 📊 Báo Cáo Viên (Daily Reporter)

**File:** `src/shared/ai/agentDailyReport.ts` (mới — cần tạo)
**Trigger:** Cron `/api/cron/manager` — 21:00 giờ tiệm mỗi tối
**Mức tự động:** AUTO (push tới owner qua SMS/email)
**Model:** `claude-haiku-4-5`

**Làm gì:**
1. Thu thập: doanh thu hôm nay (Square thật nếu có, giá catalog nếu không), số lịch, no-show, khách mới
2. So sánh: hôm qua + tuần trước cùng ngày
3. Preview ngày mai: slots đã đặt, slot trống, lịch rủi ro cao
4. AI viết tóm tắt 4-5 dòng bằng `language_primary`
5. Gửi tới owner qua kênh `owner_notification_channel` (SMS/email/both)

**Owner notification pipeline (mới):**
- Thêm `salons.owner_notification_channel: "sms" | "email" | "both"` (default `"email"`)
- Thêm `salons.owner_phone` nếu chưa có
- Reuse `sendOwnerBookingNotification` pattern đã có (thêm report type)

**DB tables:** `bookings`, `salon_client_spend` (Square), `ai_actions_log`
**SIP fields:** `language_primary`, `primary_goal`

---

### 4.5 📡 Radar (Watchdog)

**File:** `src/shared/watchdog/agentWatchdog.ts` (đã có — cần tách khỏi Square, mở rộng alerts)
**Trigger:** Cron `/api/cron/manager` — mỗi giờ (không phải daily)
**Mức tự động:** AUTO (alerts surface trong ActivityFeed)
**Model:** `claude-haiku-4-5`

**Làm gì:** Scan operational data → AI đánh giá mức độ đáng chú ý → ghi `watchdog_alerts`.

**Alert types (mở rộng từ v2):**

| Kind | Trigger | Severity |
|---|---|---|
| `no_show_spike` | No-show 7d > 2× tuần trước | warning/critical |
| `protection_gap` | Upcoming high-risk bookings có no card | warning |
| `sync_stuck` | Square/Wix sync stale > 2h | warning |
| `low_bookings` | Ngày mai < 30% capacity | info |
| `demand_drop` | Lịch 7d tới thấp hơn 7d vừa rồi 40% | warning |
| `revenue_anomaly` | Doanh thu hôm nay lệch > 50% vs 4-week avg | warning |
| `slow_period_opportunity` | Gap trống dài trong giờ cao điểm | info |

**Gap cần fix:**
- Hiện `ActivityFeed.tsx` + `ActivityBell` KHÔNG đọc `watchdog_alerts` (verified). P2 sẽ thêm.
- Cron gắn square-sync → tách (P1).
- `syncStaleMinutes` check cứng vào Square → phải chạy kể cả không có Square.

**DB tables:** `watchdog_alerts`, `watchdog_state` (throttle 12h, đã có)
**SIP fields:** `primary_goal` (điều chỉnh threshold), `language_primary`

---

### 4.6 ⭐ Người Trả Lời (Review Responder)

**File:** `src/shared/ai/agentReviewResponder.ts` (mới — cần tạo)
**Trigger:** Webhook khi phát hiện Google Review mới (polling nếu webhook không khả dụng)
**Mức tự động:** 4-5 sao = AUTO | 1-3 sao = ESCALATE
**Model:** `claude-sonnet-4-5` (review response ảnh hưởng public reputation)

**Làm gì:**
- 4-5 sao: AI soạn + auto-post reply bằng ngôn ngữ của reviewer (detect từ review text), tone từ SIP
- 1-3 sao: AI soạn draft + push notification tới owner "Có review xấu — bạn có muốn sửa nháp không?", KHÔNG auto-post
- Ghi `ai_actions_log` (4-5 sao = AUTO, 1-3 sao = ESCALATE + pending)

**DB tables:** `ai_actions_log`
**SIP fields:** `brand_voice`, `tone_examples`, `language_primary`

**Failure mode:** Google API quota → queue lại, retry sau 1h. Review 1-3 sao không bao giờ auto-post dù agent lỗi.

---

### 4.7 📱 Người Viết Bài (Social Content)

**File:** `src/shared/ai/agentSocialContent.ts` (mới — tạo Phase 1 trước)
**Trigger:** Cron `/api/cron/manager` — 3x/tuần (Mon/Wed/Fri 8:00 sáng giờ tiệm)
**Mức tự động:** Phase 1: AUTO (tạo draft, owner copy-paste) | Phase 2: AUTO post qua Meta API
**Model:** `claude-haiku-4-5` (Phase 1), `claude-sonnet-4-5` (Phase 2 với image caption)

**Làm gì (Phase 1):**
1. Đọc data thật: dịch vụ phổ biến tuần này, tỷ lệ lấp đầy, mùa/dịp đặc biệt
2. AI soạn caption Instagram/Facebook (ngôn ngữ từ SIP, tone từ `brand_voice`)
3. Gợi ý loại hình ảnh phù hợp (không generate hình — chỉ mô tả)
4. Gửi draft tới owner qua email/SMS: "Caption mới cho [thứ] — copy để đăng"

**Phase 2 (P7):** Kết nối Meta API, auto-post lên Instagram Business nếu owner bật.

**DB tables:** `ai_actions_log`
**SIP fields:** `brand_voice`, `language_primary`, `tone_examples`, `primary_goal`

---

### 4.8 🎂 VIP Care

**File:** `src/shared/ai/agentVipCare.ts` (mới — cần tạo)
**Trigger:** Cron `/api/cron/manager` — daily 8:00 sáng giờ tiệm
**Mức tự động:** AUTO
**Model:** `claude-haiku-4-5`

**VIP definition** (từ `salon_client_spend` + visit count):
- Spend top 10% của tiệm, HOẶC
- ≥ 10 lần ghé trong 12 tháng

**Làm gì:**
1. **Birthday (7 ngày trước):** Gửi tin cá nhân + tự động giữ slot ưa thích của họ (dịch vụ hay làm nhất × staff hay gặp nhất) — ghi note vào booking
2. **VIP inactive 30 ngày** (vs 45d cho khách thường): trigger win-back sớm hơn với tone ưu tiên cao hơn
3. **Milestone:** Lần thứ 10, 25, 50 → gửi tin cảm ơn đặc biệt

**DB tables:** `bookings`, `salon_client_spend`, `client_profiles`, `ai_actions_log`
**SIP fields:** `brand_voice`, `language_primary`, `contact_window`, `tone_examples`

---

### 4.9 🧭 Chiến Lược Gia (Weekly Strategist)

**File:** `src/shared/ai/agentStrategist.ts` (mới — cần tạo)
**Trigger:** Cron `/api/cron/manager` — Chủ nhật 9:00 tối giờ tiệm
**Mức tự động:** Flash deal nhỏ / message tweak = ACT+UNDO | Thay đổi cơ cấu = ESCALATE
**Model:** `claude-sonnet-4-5` (phân tích 4-week trend cần reasoning sâu)

**Làm gì:**
1. Phân tích 4 tuần: revenue trend, dịch vụ tăng/giảm, slot trống theo giờ/ngày, retention rate
2. Đối chiếu với `primary_goal` từ SIP
3. Đề xuất 2-3 actions cụ thể với lý do (ví dụ: "Thứ 3 chiều trống 60% — flash deal -15% sẽ lấp đầy")
4. Flash deal / message tweak nhỏ → ACT+UNDO (tự áp dụng, owner undo trong 60')
5. Đổi giá / thêm/bỏ dịch vụ → ESCALATE (gửi draft + link tới settings page)

**DB tables:** `bookings`, `services`, `salon_client_spend`, `ai_actions_log`
**SIP fields:** `primary_goal`, `noshow_strictness`, `language_primary`

---

## 5. Thay đổi hạ tầng cần thiết

### 5.1 Cron độc lập `/api/cron/manager`

**Vấn đề hiện tại:** Radar/Win-back/Rebook/backfill Gác Cửa chạy ké trong `square-sync` → bỏ Square = 4 agent chết.

**Fix:** Tạo `/api/cron/manager` (chạy `0 * * * *`), lặp qua `salons WHERE is_active = true` (không qua `square_integrations`). Mỗi agent tự gate + throttle. Gỡ AI calls khỏi `square-sync`.

**Thêm vào `vercel.json`:**
```json
{ "path": "/api/cron/manager", "schedule": "0 * * * *" }
```

Lịch nội bộ trong route: 8:00 sáng giờ tiệm = VIP Care + Social draft; 21:00 = Báo Cáo Viên; hourly = Radar; Chủ nhật 21:00 = Chiến Lược Gia.

### 5.2 Owner notification pipeline

**Hiện tại:** `sendOwnerBookingNotification` chỉ gửi khi có booking event.
**Cần thêm:**
- `salons.owner_notification_channel: "sms" | "email" | "both"` (default `"email"`)
- Function `sendOwnerAlert(salonId, type, message, undoToken?)` — dùng chung cho Báo Cáo Viên + Radar + ACT+UNDO notifications
- Reuse Resend (email) + Twilio (SMS) đã có

### 5.3 Audit trail — bảng `ai_actions_log`

```sql
CREATE TABLE ai_actions_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES salons(id),
  agent       text NOT NULL,       -- 'winback' | 'vip_care' | 'daily_report' | ...
  action_type text NOT NULL,       -- 'sent_sms' | 'sent_email' | 'set_flash_deal' | ...
  target_id   uuid,                -- booking_id / client_profile_id nếu có
  payload     jsonb,               -- what was sent/done
  undo_deadline timestamptz,       -- NULL = không undo được
  undone_at   timestamptz,
  created_at  timestamptz DEFAULT now()
);
```

Reuse bề mặt `ActivityFeed` (đã có kind `"ai"`) để hiện log này — không tạo trang mới.

### 5.4 SIP builder

`src/shared/ai/buildSip.ts`:
```typescript
async function buildSip(salonId: string): Promise<SalonIntelligenceProfile>
async function rebuildSipIfStale(salonId: string): Promise<void> // called hourly, skips if < 24h old
```

Triggers:
- Manager Briefing confirm → gọi ngay
- Settings change hook (settings server action) → `rebuildSipIfStale`
- Chiến Lược Gia weekly eval → `buildSip` fresh

---

## 6. Manager Briefing UI

**Route:** `/dashboard/[slug]/setup/manager-briefing`
**Access:** Owner + Admin only
**Component type:** Chat interface (messages stream vào, không phải form)

### Flow kỹ thuật

```
User message → POST /dashboard/[slug]/setup/manager-briefing (server action)
  → Accumulate conversation history (session state)
  → Sonnet generates next question OR SIP draft when complete
  → Client streams response

When complete:
  → Show SIPReviewCard (editable JSON fields rendered as form)
  → Owner edits inline → confirm
  → buildSip() writes salons.ai_profile
  → Show "Sẵn sàng" summary: list auto/escalate actions
```

**Re-run:** Nút "Cấu hình lại AI Manager" trong `/dashboard/[slug]/settings` mục AI.

---

## 7. Failure modes & mitigations

| Failure mode | Mitigation |
|---|---|
| Agent hành động trên data sai (wrong customer) | Guard function validate customer match trước khi gửi; log full payload trong `ai_actions_log` |
| Undo window hết nhưng owner muốn cancel | ESCALATE path tạo manual task trong ActivityFeed; Chiến Lược Gia không auto-charge nên luôn reversible |
| Owner chưa cài kênh thông báo | Fallback email tới `salons.owner_email`; badge "chưa cài notification" trong Settings |
| SIP cũ sau khi đổi settings lớn | Settings server action trigger `rebuildSipIfStale`; Chiến Lược Gia weekly re-eval |
| Agent gửi tin ngôn ngữ sai | Language đọc từ `SIP.language_primary` (không hardcode); guard kiểm tra charset plausibility |
| Hai agent liên lạc khách cùng ngày | `ai_actions_log` check: nếu khách đã nhận AI message trong 24h → skip (dedupe query) |
| Square API down → Báo Cáo Viên thiếu data | Fallback về `bookings.price_cents` catalog; note rõ trong báo cáo "dùng giá niêm yết, không phải thanh toán thật" |
| Manager Briefing bị bỏ dở | SIP không ghi nếu chưa confirm; agent đọc SIP null → fallback về default config |
| SIP chưa có (tiệm cũ chưa briefing) | Mọi agent có `defaultSip(salon)` fallback đọc từ `salons` table fields hiện có |

---

## 8. Thứ tự build (mỗi phase = 1-2 PRs)

### P0 — Hợp nhất cổng no-show + tách cron khỏi Square *(correctness + infrastructure)*
- `handleBookingProtection(bookingId, channel)` là cổng chung cho tất cả kênh
- Language đọc từ SIP thay vì hardcode
- `/api/cron/manager` tạo mới, gỡ AI calls khỏi `square-sync`
- Thêm vào `vercel.json`

### P1 — SIP builder + Manager Briefing *(foundation của v3)*
- Cột `salons.ai_profile` (migration)
- `buildSip.ts` + `rebuildSipIfStale`
- Chat UI `/setup/manager-briefing`
- Default SIP fallback cho tiệm cũ

### P2 — Báo Cáo Viên + owner notification pipeline *(quick win, visible value)*
- `sendOwnerAlert()` unified function
- `agentDailyReport.ts`
- Settings UI: owner_notification_channel

### P3 — Khép vòng lặp: Kéo Về/Nhắc Hẹn tự gửi + Radar → ActivityFeed
- `winback_suggestions` → auto-send với ACT+UNDO
- `watchdog_alerts` → `ActivityFeed` + `ActivityBell` badge
- `ai_actions_log` table + undo endpoint

### P4 — Người Trả Lời + VIP Care
- Google Review webhook/polling
- `agentReviewResponder.ts` (4-5★ AUTO, 1-3★ ESCALATE)
- `agentVipCare.ts` (birthday + milestone + early win-back)

### P5 — Người Viết Bài Phase 1 (draft only)
- `agentSocialContent.ts`
- Draft gửi qua email/SMS tới owner

### P6 — Chiến Lược Gia + Revenue Optimizer
- `agentStrategist.ts`
- Flash deal ACT+UNDO endpoint
- Structural change ESCALATE notifications

### P7 — Người Viết Bài Phase 2 (Meta API auto-post)
- Meta Graph API integration
- Admin UI: connect Instagram Business account

---

## 9. Không build

- Trang "AI Manager" riêng với persona/avatar — không có nhân vật, không có daily-brief kiểu trợ lý chào buổi sáng
- Bảng DB mới khi có thể reuse: `ai_policy_decisions`, `winback_suggestions`, `watchdog_alerts` đã có → chỉ thêm `ai_actions_log`
- REST routes — mọi mutation qua Server Actions (ARCHITECTURE_LOCK)
- Auto-charge thẻ, auto-đổi giá — luôn ESCALATE không ngoại lệ
- Copy code agent vào từng app — khi cần dùng ở Phofit/GrocIQ → extract sang `@autoapp/ai-manager` package

---

## 10. Checklist trước khi build P0

- [ ] Migration `salons.ai_profile jsonb` an toàn (nullable, no default)
- [ ] `ai_actions_log` table migration
- [ ] Default SIP fallback không crash khi `ai_profile = null`
- [ ] Cron `/api/cron/manager` có CRON_SECRET guard (như các cron khác)
- [ ] Gỡ AI calls khỏi `square-sync` không phá Square hiện có
- [ ] `handleBookingProtection` không thay đổi behavior với tiệm đã có data
- [ ] Tất cả agent đọc SIP qua helper `getSip(salonId)` (cache + fallback) — không query trực tiếp
