import "server-only";

/** Shared by the schema-compatible pause release and the receipt release.
 * No database or provider lookup is needed to stop new capture work.
 * Existing processes must still be drained when deploying the pause release. */
export function isCardCapturePaused(): boolean {
  return process.env.NAILIQ_CARD_SAVE_DISPATCH_DISABLED === "true";
}
export function assertCardCaptureActive(): void {
  if (isCardCapturePaused()) throw new Error("card_capture_paused");
}
