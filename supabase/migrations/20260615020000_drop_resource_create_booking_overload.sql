-- P0 HOTFIX (already applied live 2026-06-14): drop the orphaned 14-arg
-- create_public_booking overload (resource-layer, p_resource_id uuid DEFAULT NULL).
--
-- WHY: two overloads coexisted — the 13-arg identity version (PR #458) and this
-- 14-arg resource version. Because p_resource_id has a DEFAULT, a 13-key
-- PostgREST RPC body matched BOTH → PGRST203 "Could not choose the best
-- candidate function" → EVERY online booking failed ("Could not complete
-- booking", 0 rows). The resource layer is not merged and no code references
-- p_resource_id, so this overload is orphaned.
--
-- ⚠️ When the resource-layer branch lands, DO NOT re-add a separate 14-arg
-- overload. Merge resource logic (auto-assign + conflict check) INTO the single
-- 13-arg create_public_booking, or PostgREST ambiguity returns. Verify after any
-- migration touching this RPC: `select count(*) from pg_proc
-- where proname='create_public_booking'` must be 1.
drop function if exists public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer, text, uuid, integer, text, uuid
);
