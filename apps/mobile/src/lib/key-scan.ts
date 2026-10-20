/**
 * A private key read by the scanner (`/scan?purpose=key`), handed back to the import
 * screen in memory: never as a route param, so it stays out of URLs and history.
 */
let scanned: string | null = null;
export function holdScannedKey(key: string) {
  scanned = key;
}
export function takeScannedKey() {
  const key = scanned;
  scanned = null;
  return key;
}
