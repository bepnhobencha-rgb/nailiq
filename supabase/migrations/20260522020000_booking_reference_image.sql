-- Add reference image support to bookings.
-- Stores the Supabase Storage path of a client's inspiration image.
-- Uploaded before booking, attached after booking_id is known.

alter table public.bookings
  add column if not exists reference_image_path text;

comment on column public.bookings.reference_image_path is
  'Path in booking-refs Storage bucket for client inspiration image uploaded at booking time.';
