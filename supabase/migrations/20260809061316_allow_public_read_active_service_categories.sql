-- Public booking is anonymous until the customer verifies their phone.
-- Expose only active category labels so services can be grouped in that flow.
create policy "anon_read_active_service_categories"
on public.service_categories
for select
to anon
using (deleted_at is null);
