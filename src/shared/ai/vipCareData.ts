import type { Row } from "@/shared/integrations/square/looseDb";

type PageResult = {
  data: Row[] | null;
  error: { message: string } | null;
};

type PageFetcher = (from: number, to: number) => PromiseLike<PageResult>;
type BatchPageFetcher = (
  ids: string[],
  from: number,
  to: number,
) => PromiseLike<PageResult>;

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_ID_BATCH_SIZE = 100;

/**
 * Supabase projects commonly cap a single response at 1,000 rows. VIP Care
 * must not silently make decisions from a truncated customer or visit list, so
 * every potentially-unbounded read is consumed page by page and fails closed.
 */
export async function fetchAllVipRows(
  label: string,
  fetchPage: PageFetcher,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<Row[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`[vip_care:${label}] page size must be a positive integer`);
  }
  const rows: Row[] = [];

  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1);
    if (result.error) {
      throw new Error(`[vip_care:${label}] ${result.error.message}`);
    }

    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** Keep `.in(...)` URLs bounded while also paginating one-to-many rows. */
export async function fetchVipRowsForIds(
  label: string,
  ids: Iterable<string>,
  fetchPage: BatchPageFetcher,
  idBatchSize = DEFAULT_ID_BATCH_SIZE,
): Promise<Row[]> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  const rows: Row[] = [];

  for (let start = 0; start < uniqueIds.length; start += idBatchSize) {
    const batch = uniqueIds.slice(start, start + idBatchSize);
    rows.push(
      ...(await fetchAllVipRows(
        `${label}:batch_${Math.floor(start / idBatchSize)}`,
        (from, to) => fetchPage(batch, from, to),
      )),
    );
  }

  return rows;
}
