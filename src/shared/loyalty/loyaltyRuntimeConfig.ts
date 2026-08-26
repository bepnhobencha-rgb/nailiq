/**
 * Loyalty value mutations need one atomic tenant-bound RPC. The current
 * read-modify-write implementation cannot safely survive concurrency or a lost
 * response, so keep it unavailable until that DB contract exists.
 */
export const LOYALTY_VALUE_MUTATIONS_ENABLED = false;
