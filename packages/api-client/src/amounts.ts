/** Fixed-point input; never routes token quantities through floating-point math. */
export function parseTokenAmount(text: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    text.length > 96 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)
  )
    throw new Error('Enter a positive amount.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const value = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
  if (value <= 0n || value >= (1n << 256n) - 1n)
    throw new Error('Amount is outside the supported range.');
  return value.toString();
}

export function formatTokenAmount(raw: string, decimals: number): string {
  const s = raw.padStart(decimals + 1, '0');
  if (decimals === 0) return s;
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '');
}
