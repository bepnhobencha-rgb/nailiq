# AI Prefill Setup Wizard — Design Spec

**Created:** 2026-05-19  
**Status:** Implemented (P2.2–P2.3)  
**Scope:** Zero-service salon onboarding shortcut.

---

## Problem

A first-time salon owner lands on Setup → Services with an empty list. They must manually type every service name, price, and duration — 10–15 rows minimum. This is friction that kills activation for non-tech-savvy owners.

## Solution

One-click "Import from menu photo" flow powered by Claude Vision. Owner takes a photo of their price list (posted on wall, laminated on counter, or screenshot from their old system). AI reads it and pre-fills the services list for them to review and confirm.

---

## User Flow

```
Setup Services (0 rows)
  └─► [Import from menu photo] banner
        └─► /setup/ai-prefill (wizard entry)
              ├─ Step 1 — Pick input method
              │   ├─ 📷 Upload ảnh menu  (file input → base64)
              │   ├─ 🔗 Paste link ảnh   (URL input → Claude URL source)
              │   └─ ✏️ Tự nhập          (skip → /setup/services)
              ├─ Step 2 — AI Processing  (spinner, ~3–8s)
              └─ Step 3 — Review & Confirm
                  ├─ Checkbox list of extracted services
                  ├─ Inline price + duration editing
                  ├─ [Nhập N dịch vụ] primary CTA → bulk insert → /setup/services
                  └─ [Nhập thủ công] escape hatch → /setup/services
```

---

## AI Details

- **Model:** `claude-sonnet-4-6` (Vision)
- **Input:** JPEG/PNG/WEBP image (upload: base64, max 4MB client-side resized; URL: passed directly to Anthropic)
- **Output:** JSON array of `{name, price_cents, duration_minutes}`
- **Prompt strategy:** Explicit field rules + duration estimation table for unlabelled menus
- **Privacy:** Image bytes are NOT stored. Sent to Anthropic API only, then discarded.
- **Fallback:** AI returns `[]` or fails → show "Không đọc được menu, thử lại hoặc nhập tay" + escape hatch

---

## Server Actions

- `analyzeMenuImage(slug, base64, mimeType)` — membership-gated, calls Claude Vision, returns `ExtractedService[]`
- `analyzeMenuImageUrl(slug, imageUrl)` — same but URL source
- `bulkImportAIServices(slug, services)` — membership-gated, bulk-inserts to `services` table, respects plan limits

## Key Constraints

- No new primitive UI components (uses Button, Modal, SaveButton, SetupToast)
- Image bytes never touch our DB or Blob storage (privacy)
- Plan limit `maxServices` respected at import time (truncates or errors)
- Works on mobile (camera capture via `accept="image/*;capture=environment"`)
- Graceful fallback when `ANTHROPIC_API_KEY` is missing (dev environments)
