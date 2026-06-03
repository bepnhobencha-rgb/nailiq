# Tech Nails Setup Guide

## Overview

Setup for Tech Nails salon (Langley, BC) to use NailIQ Receptionist Center with 2 staff members.

---

## ✅ Completed Setup

### 1. **Database Configuration**
- ✅ Created migration: `20260603120000_tech_nails_admin_setup.sql`
  - Added `basic_mode_forced` column to `salons` table
  - Added role constraint to allow `owner`, `admin`, `receptionist` roles
  - Set `tech-nails` salon with `basic_mode_forced = true`

### 2. **Basic Mode Auto-Enable**
When receptionist logs into Tech Nails:
- localStorage automatically enables Basic Mode
- Cannot toggle off (locked UI)
- Shows only: Queue, Calendar, Timeline, Clients, Settings
- Hides: Revenue, Owner settings, Advanced features

### 3. **Role Hierarchy**
```
Owner (thehuytgvn@gmail.com)
├─ Admin (hungnguyenbcca@gmail.com) — manage staff, view all
└─ Receptionist (2 staff) — front-desk only, Basic Mode locked
```

---

## 🔧 How to Add Receptionist Staff

### Option 1: Direct SQL (Fast)
```sql
-- Run in Supabase
INSERT INTO public.salon_members (salon_id, user_id, role)
VALUES (
  (SELECT id FROM public.salons WHERE slug = 'tech-nails'),
  gen_random_uuid(),
  'receptionist'
);
```

### Option 2: Admin UI (When Complete)
1. Login as `hungnguyenbcca@gmail.com`
2. Go to `/dashboard/tech-nails/settings/staff`
3. Click "Add Staff Member"
4. Enter phone or email
5. Select role: "Receptionist"
6. Click "Add Staff Member"

---

## 📞 Login Flow for Receptionist

1. Go to `/register` 
2. Enter phone: `+1-778-555-0001` (example)
3. Verify OTP (shown on screen in demo mode)
4. Redirect to `/dashboard/tech-nails/center`
5. **Basic Mode automatically enabled** ✓
6. See Front-desk Queue, Calendar, Timeline only

---

## 🚀 Next Steps

### Immediate (Do Now)
1. **Add hungnguyenbcca@gmail.com as Tech Nails Admin**
   - Create user in Supabase Auth: email = hungnguyenbcca@gmail.com
   - Insert `salon_members` row with role = "admin"
   
2. **Seed 2 Receptionist Accounts** (or let them self-register via Admin UI)
   - Option A: Use SQL INSERT above
   - Option B: Wait for Admin UI completion + hungnguyenbcca adds them

### Short Term (Next Build)
- [ ] Regenerate Supabase types (`npm run generate:types` or Supabase CLI)
- [ ] Test build passes (fix `SalonShape` type issue)
- [ ] Deploy to production
- [ ] Train Tech Nails staff on Receptionist Center

### Longer Term
- [ ] Admin dashboard for staff management (`/dashboard/[slug]/settings/staff`)
- [ ] Invitation links for staff (instead of self-register)
- [ ] Staff export / reporting

---

## 🎯 What Tech Nails Receptionists See

```
┌─ NailIQ Receptionist Center ──────────────┐
│                                           │
│  Queue (waiting guests)                   │
│  Today's Calendar (time slots)            │
│  Staff Timeline (real-time bookings)      │
│  Clients (find, add notes)                │
│  Settings (limited - basic only)          │
│                                           │
│  ❌ NO Revenue tile                      │
│  ❌ NO Advanced settings                  │
│  ❌ NO Owner features                     │
│                                           │
└───────────────────────────────────────────┘
```

---

## 📝 Current Code Changes

### Files Modified
1. `src/shared/lib/salonMemberRole.ts` — Added `admin`, `receptionist` roles
2. `src/shared/dashboard/useBasicMode.ts` — Auto-enable for `basic_mode_forced`
3. `src/shared/dashboard/loadReceptionistCenterData.ts` — Load `basic_mode_forced` flag
4. `src/components/receptionist/ReceptionistCenter.tsx` — Pass flag to useBasicMode
5. `src/app/dashboard/[slug]/settings/staff/page.tsx` — Admin staff management page
6. `src/components/dashboard/StaffManagementHub.tsx` — Add/remove staff UI
7. `src/shared/dashboard/addStaffMemberAction.ts` — Server action to add staff
8. i18n files — Added role labels

### Pending (Build Issue)
- Supabase auto-generated types need regeneration (`SalonShape` missing `basic_mode_forced`)

---

## ✨ Key Features Enabled

- ✅ Tech Nails receptionist sees ONLY front-desk UI
- ✅ Basic Mode locked ON (can't turn off)
- ✅ Admin dashboard for staff management
- ✅ Multi-role support (owner, admin, receptionist, senior, nail_tech)
- ✅ No advanced features visible to reduce confusion

---

## 🆘 Troubleshooting

**Q: Receptionist logs in but sees full dashboard?**
- A: Check `salon_members.role` = "receptionist" (case-sensitive)
- A: Check `salons.basic_mode_forced` = true for tech-nails
- A: Clear localStorage: `localStorage.removeItem('nailiq-basic-mode')`

**Q: Admin can't add staff?**
- A: Check `salon_members` role for hungnguyenbcca = "admin"
- A: Ensure `/settings/staff` page is deployed

**Q: New role not appearing?**
- A: Regenerate Supabase types (run `npx supabase gen types typescript --local`)

---

## Contact

For questions about Tech Nails setup, contact Huy (thehuytgvn@gmail.com).
