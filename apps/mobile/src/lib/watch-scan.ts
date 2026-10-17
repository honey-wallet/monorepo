let scanned: string | null = null;
export function holdWatchedAddress(address: string) {
  scanned = address;
}
export function takeWatchedAddress() {
  const address = scanned;
  scanned = null;
  return address;
}
