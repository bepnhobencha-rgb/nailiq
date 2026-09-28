// Synthetic, isolated local PostgreSQL contract test; never reads application env.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const run = promisify(execFile);
const postgresBin = process.env.NAILIQ_NATIVE_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const bin = (name) => join(postgresBin, name);
const root = mkdtempSync('/private/tmp/nailiq-card-retry-pg-');
const data = join(root, 'data');
const port = 20000 + Math.floor(Math.random() * 30000);
let started = false;
const args = ['-X', '-v', 'ON_ERROR_STOP=1', '-h', root, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-At'];
const sql = (query) => execFileSync(bin('psql'), args, { input: query, encoding: 'utf8' }).trim();
const salon = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const actor = '20000000-0000-4000-8000-000000000001';
const booking = '30000000-0000-4000-8000-000000000001';
const hash = "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('qa@example.invalid','UTF8')),'hex')";
const claim = (s = salon, a = actor, fp = hash) => `select public.claim_card_retry_email('${s}','${booking}','${a}',${fp});`;
try {
  execFileSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--no-instructions'], { stdio: 'pipe' });
  execFileSync(bin('pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-c listen_addresses= -k ${root} -p ${port}`, 'start'], { stdio: 'pipe' });
  started = true;
  sql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  sql(`CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
    CREATE TABLE public.salons(id uuid primary key, noshow_protection_enabled boolean, email_links_enabled boolean);
    CREATE TABLE public.salon_members(salon_id uuid, user_id uuid, role text);
    CREATE TABLE public.bookings(id uuid primary key, salon_id uuid, deleted_at timestamptz, status text,
      start_time_utc timestamptz, noshow_card_required boolean, noshow_card_id uuid, card_protection_status text, client_email text);
    INSERT INTO public.salons VALUES('${salon}',true,true),('${other}',true,true);
    INSERT INTO public.salon_members VALUES('${salon}','${actor}','owner');
    INSERT INTO public.bookings VALUES('${booking}','${salon}',null,'confirmed',now()+interval '1 day',true,null,'retry_required','qa@example.invalid');
    GRANT USAGE ON SCHEMA public TO service_role;
    GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;`);
  sql(readFileSync(new URL('../supabase/migrations/20260925191112_add_card_retry_email_receipts.sql', import.meta.url), 'utf8'));
  sql(readFileSync(new URL('../supabase/migrations/20260927103300_use_builtin_sha256_card_retry_claim.sql', import.meta.url), 'utf8'));
  assert.equal(sql("select has_schema_privilege('service_role','extensions','usage')"), 'f');
  assert.equal(JSON.parse(sql(claim(other))).state, 'forbidden');
  sql(`INSERT INTO public.salon_members VALUES('${other}','${actor}','owner');`);
  assert.equal(JSON.parse(sql(claim(other))).state, 'invalid_booking');
  assert.equal(JSON.parse(sql(claim(salon, actor, "repeat('a',64)"))).state, 'invalid_booking');
  for (const change of ["status=null", "status='cancelled'", "start_time_utc=now()-interval '1 day'",
    "noshow_card_required=false", `noshow_card_id='${actor}'`, "card_protection_status='saving'", "deleted_at=now()"] ) {
    const state = sql(`BEGIN; UPDATE public.bookings SET ${change}; ${claim()} ROLLBACK;`).split('\n').find(line => line.startsWith('{'));
    assert.equal(JSON.parse(state).state, 'invalid_booking', change);
  }
  assert.equal(sql('select count(*) from public.booking_card_retry_email_receipts'), '0');
  sql(`UPDATE public.salon_members SET role='nail_tech'`);
  assert.equal(JSON.parse(sql(claim())).state, 'forbidden');
  sql(`UPDATE public.salon_members SET role='receptionist'`);
  assert.equal(sql(`select has_function_privilege('anon','public.claim_card_retry_email(uuid,uuid,uuid,text)','execute')
    OR has_function_privilege('authenticated','public.claim_card_retry_email(uuid,uuid,uuid,text)','execute')
    OR has_table_privilege('authenticated','public.booking_card_retry_email_receipts','select');`), 'f');
  assert.equal(sql(`select relrowsecurity from pg_class where oid='public.booking_card_retry_email_receipts'::regclass`), 't');
  const results = await Promise.all(Array.from({ length: 12 }, async () => {
    const r = await run(bin('psql'), [...args, '-c', `SET ROLE service_role; ${claim()}`]);
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  }));
  assert.equal(results.filter(r => r.state === 'claimed').length, 1);
  assert.equal(results.filter(r => r.state === 'blocked').length, 11);
  const winner = results.find(r => r.state === 'claimed');
  const complete = (s, attempt, provider) => `select public.complete_card_retry_email('${s}','${winner.id}','${attempt}',${provider});`;
  assert.equal(sql(complete(other, winner.attempt_id, "'synthetic-id'")), 'f');
  assert.equal(sql(complete(salon, actor, "'synthetic-id'")), 'f');
  assert.equal(sql(complete(salon, winner.attempt_id, "'synthetic-id'")), 't');
  assert.equal(sql(complete(salon, winner.attempt_id, 'null')), 'f');
  assert.equal(JSON.parse(sql(claim())).state, 'already_accepted');
  assert.equal(sql('select count(*) from public.booking_card_retry_email_receipts'), '1');
  // Separate synthetic occurrence proves unknown stays blocked across time.
  sql(`DELETE FROM public.booking_card_retry_email_receipts;`);
  const uncertain = JSON.parse(sql(claim()));
  sql(`select public.complete_card_retry_email('${salon}','${uncertain.id}','${uncertain.attempt_id}',null);
    UPDATE public.booking_card_retry_email_receipts SET created_at=now()-interval '2 days';`);
  assert.equal(JSON.parse(sql(claim())).state, 'blocked');
  console.log('PASS: 12 concurrent claims -> 1 winner; tenant/role/ACL/RLS; fenced completion; accepted replay; unknown after 48h. Synthetic minimal schema, not full migration rehearsal.');
} finally {
  try {
    if (started) execFileSync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'pipe' });
  } finally {
    rmSync(root, { recursive: true, force: true });
    console.log('Removed only the isolated temporary PostgreSQL cluster created by this test. Existing QA unchanged.');
  }
}
