-- Add admin role support + basic mode forcing
-- For Tech Nails: hungnguyenbcca@gmail.com as Admin
-- Receptionist force Basic Mode by default

-- 1. Add basic_mode_forced column to salons (default: false)
ALTER TABLE public.salons 
ADD COLUMN IF NOT EXISTS basic_mode_forced boolean DEFAULT false;

-- 2. Add constraint to salon_members.role to allow owner/admin/receptionist
-- First, check if constraint exists and drop if needed
ALTER TABLE public.salon_members 
DROP CONSTRAINT IF EXISTS salon_members_role_check;

ALTER TABLE public.salon_members 
ADD CONSTRAINT salon_members_role_check 
CHECK (role IN ('owner', 'admin', 'receptionist'));

-- 3. Add hungnguyenbcca@gmail.com user if not exists
-- (We'll do this separately via user creation flow)

-- 4. Comment for clarity
COMMENT ON COLUMN public.salons.basic_mode_forced IS 
'When true, receptionist auto-enables Basic Mode (localStorage) on login';

COMMENT ON COLUMN public.salon_members.role IS 
'owner: full access to salon | admin: manage staff/operations | receptionist: front-desk only';
