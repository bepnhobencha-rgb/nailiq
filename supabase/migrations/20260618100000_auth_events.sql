-- Login / logout audit: who signed in/out, when, from what device + IP. Surfaced
-- in the owner Activity log ("Đăng nhập" tab). Service-role writes (the auth
-- chokepoints log via recordAuthEvent); RLS-on / no policies = owner reads it
-- only through the owner-gated service-role feed loader.
create table if not exists auth_events (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid,
  user_id uuid,
  event_type text not null,          -- login | logout
  actor_role text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists auth_events_salon_created_idx
  on auth_events (salon_id, created_at desc);

alter table auth_events enable row level security;
