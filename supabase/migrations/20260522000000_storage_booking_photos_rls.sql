-- RLS policies for the booking-photos Storage bucket.
-- Bucket was created with public=false. All access goes through signed URLs
-- (service-role uploads path) or short-lived download URLs (Edge Function).
-- Direct client SELECT is not needed; Edge Functions use service-role key.

-- Allow salon members (owner/senior/nail_tech) to upload photos.
CREATE POLICY "salon_members_upload_booking_photos"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'booking-photos'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  );

-- Allow salon members to read their own salon's photos.
CREATE POLICY "salon_members_read_booking_photos"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'booking-photos'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  );

-- Allow salon members to delete photos (soft-delete preferred, but allow hard
-- delete for PIPEDA revocation via admin action).
CREATE POLICY "salon_members_delete_booking_photos"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'booking-photos'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  );
