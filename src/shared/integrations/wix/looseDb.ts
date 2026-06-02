/**
 * Minimal loosely-typed Supabase handle for the Wix integration.
 *
 * `bookings.wix_booking_id` and the `wix_integrations` table are added by this feature's
 * migration and aren't in the generated `Database` types yet, so the strongly-typed client
 * would reject them. This handle exposes just the query-builder surface we use — typed with
 * `unknown` (not `any`) so we stay lint-clean while casting individual reads at the call site.
 */
import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type Row = Record<string, unknown>;
type Result = { data: Row | null; error: { message: string } | null };
type ListResult = { data: Row[] | null; error: { message: string } | null };

export interface LooseQuery extends PromiseLike<ListResult> {
  select(cols?: string): LooseQuery;
  insert(values: Row | Row[]): LooseQuery;
  update(values: Row): LooseQuery;
  upsert(values: Row | Row[], opts?: { onConflict?: string }): LooseQuery;
  delete(): LooseQuery;
  eq(col: string, val: unknown): LooseQuery;
  in(col: string, vals: unknown[]): LooseQuery;
  is(col: string, val: unknown): LooseQuery;
  limit(count: number): LooseQuery;
  maybeSingle(): Promise<Result>;
  single(): Promise<Result>;
}

export interface LooseDb {
  from(table: string): LooseQuery;
}

export function looseServiceClient(): LooseDb {
  return createServiceRoleClient() as unknown as LooseDb;
}
