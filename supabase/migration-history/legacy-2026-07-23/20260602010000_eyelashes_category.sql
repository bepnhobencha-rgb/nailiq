-- Add a global "Eyelashes" service category. Eyelash-extension services (Full Set, Fill,
-- Classic, Volume/Hybrid) are common in nail salons and were previously misfiled under
-- Acrylic because they share nail wording. Global table (slug-keyed), so all salons get it.
insert into public.service_categories (slug, name_en, name_vi, sort_order)
values ('eyelashes', 'Eyelashes', 'Nối mi', 11)
on conflict (slug) do nothing;
