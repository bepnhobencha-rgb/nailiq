-- Nail Try-On photos and generated previews are accessed only by trusted
-- server routes with the service role. Keep the bucket private and mirror the
-- upload route's 10 MiB/image-only boundary on the Storage service itself.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'nail-tryon',
  'nail-tryon',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
