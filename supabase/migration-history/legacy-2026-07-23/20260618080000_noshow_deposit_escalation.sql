-- Auto-escalation: a high-risk customer (≥ N prior no-shows at this salon) must
-- pay an UPFRONT deposit (pay-to-confirm) instead of the low-friction card-on-file.
-- NULL = OFF (opt-in, no behaviour change). Set to e.g. 2 to activate.
alter table salons
  add column if not exists noshow_deposit_escalation_threshold smallint
  check (
    noshow_deposit_escalation_threshold is null
    or noshow_deposit_escalation_threshold between 1 and 10
  );

comment on column salons.noshow_deposit_escalation_threshold is
  'Prior-no-show count that escalates a customer from card-on-file to upfront pay-to-confirm deposit. NULL = escalation off (opt-in).';
