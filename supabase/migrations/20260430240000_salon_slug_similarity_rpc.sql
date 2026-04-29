-- Slug typo hints for public booking 404 (“Did you mean”) via pg_trgm similarity.

create extension if not exists pg_trgm;

create or replace function public.suggest_salon_slugs_by_similarity(p_input text)
returns setof text
language sql
stable
security invoker
set search_path = public
as $$
  select s.slug::text
  from public.salons s
  where coalesce(trim(p_input), '') <> ''
    and length(trim(p_input)) >= 2
    and similarity(
      lower(trim(s.slug::text)),
      lower(trim(p_input))
    ) > 0.12::float
  order by
    similarity(
      lower(trim(s.slug::text)),
      lower(trim(p_input))
    ) desc,
    length(s.slug::text) asc
  limit 3;
$$;

grant execute on function public.suggest_salon_slugs_by_similarity(text)
  to anon, authenticated;
