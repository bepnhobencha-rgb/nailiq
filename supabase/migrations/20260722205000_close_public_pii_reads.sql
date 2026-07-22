-- Public table reads exposed customer PII:
--   * queue_entries: every active salon's names, phones and notes
--   * reviews: all phones, emails and bearer request tokens
--
-- Both product flows already use trusted server actions / tenant-scoped staff
-- access. No public client needs direct SELECT on either base table.

DROP POLICY IF EXISTS anon_read_queue_entries ON public.queue_entries;
REVOKE SELECT ON TABLE public.queue_entries FROM anon;

DROP POLICY IF EXISTS reviews_select_by_token ON public.reviews;
REVOKE SELECT ON TABLE public.reviews FROM anon, authenticated;

COMMENT ON TABLE public.queue_entries IS
  'Contains customer PII. Public base-table reads are forbidden; salon members are tenant-scoped.';
COMMENT ON TABLE public.reviews IS
  'Contains customer PII and bearer tokens. Public review flows use trusted token-scoped server actions.';
