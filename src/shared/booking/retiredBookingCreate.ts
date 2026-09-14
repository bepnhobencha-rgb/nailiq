const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = (salonId: string, requestId: string) => `nq-retired-create:${salonId.toLowerCase()}:${requestId.toLowerCase()}`;
/** Local hint only. The database fence is authoritative, including on other devices. */
export function isBookingCreateRetired(salonId: string, requestId: string, storage?: Pick<Storage, "getItem"> | null): boolean {
  if (!UUID.test(salonId) || !UUID.test(requestId)) return false;
  try { return (storage === undefined ? window.localStorage : storage)?.getItem(key(salonId, requestId)) === "1"; }
  catch { return false; }
}
/** Call only after the server returns a durable retired receipt, never after a timeout or empty lookup. */
export function rememberRetiredBookingCreate(salonId: string, requestId: string, storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage): void {
  if (!UUID.test(salonId) || !UUID.test(requestId)) throw new Error("invalid_create_request");
  storage.setItem(key(salonId, requestId), "1");
  if (!isBookingCreateRetired(salonId, requestId, storage)) throw new Error("retirement_storage_unavailable");
}
