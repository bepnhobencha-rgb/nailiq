/**
 * Minimal loosely-typed Supabase handle for the Square integration.
 *
 * `square_integrations` + the `square_*_id` columns are added by this feature's
 * migration and aren't in the generated `Database` types yet, so the strongly
 * typed client would reject them. This exposes just the query-builder surface we
 * use — typed with `unknown` (not `any`) so we stay lint-clean while casting
 * individual reads at the call site. Mirrors the Wix integration's looseDb.
 */
import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type Row = Record<string, unknown>;
type Result = { data: Row | null; error: { message: string } | null };
type ListResult = { data: Row[] | null; error: { message: string } | null };

export interface LooseQuery extends PromiseLike<ListResult> {
  select(cols?: string): LooseQuery;
  insert(values: Row | Row[]): LooseQuery;
  update(values: Row): LooseQuery;
  upsert(values: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): LooseQuery;
  delete(): LooseQuery;
  eq(col: string, val: unknown): LooseQuery;
  in(col: string, vals: unknown[]): LooseQuery;
  is(col: string, val: unknown): LooseQuery;
  not(col: string, op: string, val: unknown): LooseQuery;
  gt(col: string, val: unknown): LooseQuery;
  gte(col: string, val: unknown): LooseQuery;
  lt(col: string, val: unknown): LooseQuery;
  order(col: string, opts?: { ascending?: boolean }): LooseQuery;
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
