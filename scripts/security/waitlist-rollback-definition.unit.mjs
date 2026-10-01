import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hardenWaitlistClaimRollback } from './waitlist-rollback-definition.mjs';

const baseline = readFileSync(new URL('../../supabase/migrations/20260723000000_folded_production_schema_baseline.sql', import.meta.url), 'utf8');
const start = baseline.indexOf('CREATE FUNCTION public.claim_waitlist_slot(');
assert.notEqual(start, -1);
const end = baseline.indexOf('$$;', start);
assert.notEqual(end, -1);
// Folded pg_dump spells CREATE and places RETURNS on the same line; the
// rehearsal separately tests the actual pg_get_functiondef snapshot.
const definition = baseline.slice(start, end + '$$;'.length).trim()
  .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
  .replace('(p_claim_token uuid) RETURNS TABLE', '(p_claim_token uuid)\n RETURNS TABLE');
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('legacy snapshot requires hardening rather than restoring a public search path', () => {
  assert.match(definition, /SET search_path TO 'public'/);
  const result = hardenWaitlistClaimRollback(definition, hash(definition));
  assert.match(result.definition, /SET search_path TO ''/);
  assert.match(result.definition, /v_e\s+public\.booking_waitlist_entries%ROWTYPE/);
  assert.doesNotMatch(result.definition, /public\.public\./);
  // Removing only the qualification and search-path changes must recover the
  // original exactly: no pricing, status, booking, or receipt logic rewrite.
  const restored = result.definition.replace("SET search_path TO ''", "SET search_path TO 'public'")
    .replace(/public\.(booking_waitlist_entries|salons|services|staff)\b/g, '$1');
  assert.equal(restored, definition);
  assert.equal(result.sourceSha256, hash(definition));
  assert.notEqual(result.hardenedSha256, result.sourceSha256);
  assert.ok(Object.isFrozen(result));
});

test('rejects missing reviewed hash and altered source before generating SQL', () => {
  assert.throws(() => hardenWaitlistClaimRollback(definition), /SHA-256 required/);
  assert.throws(() => hardenWaitlistClaimRollback(`${definition}\n`, hash(definition)), /drift/);
});

test('rejects another function even when the supplied hash matches', () => {
  const changed = definition.replace('public.claim_waitlist_slot(', 'public.other_function(');
  assert.throws(() => hardenWaitlistClaimRollback(changed, hash(changed)), /signature/);
});

test('rejects changed or already hardened security configuration', () => {
  for (const changed of [definition.replace("SET search_path TO 'public'", "SET search_path TO ''"),
    definition.replace(' SECURITY DEFINER\n', ' SECURITY INVOKER\n'),
    `${definition}\nSET search_path TO 'public'`]) {
    assert.throws(() => hardenWaitlistClaimRollback(changed, hash(changed)), /security configuration/);
  }
});

test('rejects drift in any qualification anchor instead of performing partial edits', () => {
  for (const name of ['booking_waitlist_entries', 'salons', 'services', 'staff']) {
    const changed = definition.replace(new RegExp(`\\b${name}\\b`), `public.${name}`);
    assert.throws(() => hardenWaitlistClaimRollback(changed, hash(changed)), /anchor mismatch/);
  }
});
