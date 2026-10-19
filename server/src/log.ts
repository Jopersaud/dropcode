// Structured, privacy-preserving logging. Callers must never pass codes,
// nameplates, file names, SDP, or IP addresses; only event names and counts.
export function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  if (process.env.DROPCODE_QUIET) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
