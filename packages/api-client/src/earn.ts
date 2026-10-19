import type { EarnAsset, EarnCatalog, EarnCatalogProduct, EarnObservation } from './types';

const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const address = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && !/^0x0{40}$/.test(v);
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && (v.length < MAX.length || v <= MAX);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  [...v].every((c) => {
    const n = c.codePointAt(0) ?? 0;
    return (
      n >= 32 &&
      !(n >= 127 && n <= 159) &&
      !(n >= 0x202a && n <= 0x202e) &&
      !(n >= 0x2066 && n <= 0x2069)
    );
  });
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const nullableRaw = (v: unknown) => v === null || raw(v);
const protocol = (v: unknown) => v === 'aave_v3' || v === 'morpho_vault_v2';
const chain = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v));
const asset = (v: unknown): v is EarnAsset =>
  object(v) && address(v.address) && integer(v.decimals, 255) && text(v.symbol, 64);
export function isEarnObservation(v: unknown): v is EarnObservation {
  if (
    !object(v) ||
    v.schemaVersion !== 1 ||
    v.executionAvailable !== false ||
    !protocol(v.protocol) ||
    !chain(v.chainId) ||
    !address(v.contractAddress) ||
    !asset(v.asset) ||
    !asset(v.positionAsset) ||
    !raw(v.totalSuppliedRaw) ||
    !nullableRaw(v.availableLiquidityRaw) ||
    !nullableRaw(v.supplyCapRaw) ||
    !integer(v.fetchedAtMs) ||
    v.fetchedAtMs === 0
  )
    return false;
  if (
    v.protocol === 'aave_v3'
      ? v.asset.decimals !== v.positionAsset.decimals
      : v.positionAsset.address !== v.contractAddress
  )
    return false;
  if (v.supplyApy !== null) {
    const a = v.supplyApy;
    if (
      !object(a) ||
      typeof a.fraction !== 'string' ||
      a.fraction.length > 80 ||
      !/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(a.fraction) ||
      !Number.isFinite(Number(a.fraction)) ||
      a.rewardsIncluded !== false ||
      a.basis !== (v.protocol === 'aave_v3' ? 'current_supply' : 'trailing_one_day_after_fees')
    )
      return false;
  }
  if (
    !object(v.restrictions) ||
    !['paused', 'frozen', 'supplyCapReached', 'gated'].every(
      (key) =>
        v.restrictions &&
        object(v.restrictions) &&
        (v.restrictions[key] === null || typeof v.restrictions[key] === 'boolean'),
    )
  )
    return false;
  if (
    v.vaultFees !== null &&
    (!Array.isArray(v.vaultFees) ||
      v.vaultFees.length > 2 ||
      !v.vaultFees.every(
        (fee) =>
          object(fee) &&
          ['performance', 'management'].includes(String(fee.kind)) &&
          nullableRaw(fee.rateWad) &&
          (fee.rateWad === null || BigInt(String(fee.rateWad)) <= 10n ** 18n),
      ))
  )
    return false;
  return (
    Array.isArray(v.sourceBlocks) &&
    v.sourceBlocks.length <= 3 &&
    v.sourceBlocks.every(
      (b) =>
        object(b) &&
        ['configuration', 'state', 'apy'].includes(String(b.component)) &&
        raw(b.number),
    )
  );
}
function product(v: unknown): v is EarnCatalogProduct {
  if (
    !object(v) ||
    typeof v.id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(v.id) ||
    !text(v.label, 80) ||
    !protocol(v.protocol) ||
    !chain(v.chainId) ||
    !address(v.contractAddress) ||
    !address(v.assetAddress)
  )
    return false;
  if (v.observation === null) return v.status === 'unavailable' && v.ageMs === null;
  return (
    isEarnObservation(v.observation) &&
    integer(v.ageMs, 599999) &&
    v.observation.protocol === v.protocol &&
    v.observation.chainId === v.chainId &&
    v.observation.contractAddress === v.contractAddress &&
    v.observation.asset.address === v.assetAddress &&
    (v.status === 'fresh' ? v.ageMs <= 120000 : v.status === 'stale' && v.ageMs > 120000)
  );
}
export function isEarnCatalog(v: unknown): v is EarnCatalog {
  if (
    !object(v) ||
    v.schemaVersion !== 1 ||
    v.maxAgeMs !== 120000 ||
    !Array.isArray(v.products) ||
    v.products.length > 8 ||
    !v.products.every(product) ||
    new Set(v.products.map((p) => p.id)).size !== v.products.length
  )
    return false;
  return (
    v.status ===
    (v.products.length === 0
      ? 'not_configured'
      : v.products.every((p) => p.status === 'fresh')
        ? 'ready'
        : 'degraded')
  );
}
/** Locally age a snapshot; a quiet connection must never imply indefinitely fresh rates. */
export function ageEarnCatalog(
  catalog: EarnCatalog,
  elapsedMs: number,
  now = Date.now(),
): EarnCatalog {
  const products = catalog.products.map((p): EarnCatalogProduct => {
    if (!p.observation || p.ageMs === null) return p;
    const ageMs = Math.max(p.ageMs + Math.max(0, elapsedMs), now - p.observation.fetchedAtMs);
    if (ageMs >= 600000) return { ...p, status: 'unavailable', ageMs: null, observation: null };
    return {
      ...p,
      ageMs,
      status:
        p.status === 'fresh' && ageMs <= catalog.maxAgeMs && p.observation.fetchedAtMs <= now + 5000
          ? 'fresh'
          : 'stale',
    };
  });
  return {
    ...catalog,
    products,
    status:
      products.length === 0
        ? 'not_configured'
        : products.every((p) => p.status === 'fresh')
          ? 'ready'
          : 'degraded',
  };
}
/** Display approximation only; raw rates and all execution amounts remain exact strings. */
export function formatEarnApy(fraction: string): string {
  const percent = Number(fraction) * 100;
  if (!Number.isFinite(percent)) return 'Unavailable';
  if (Math.abs(percent) > 1_000_000) return percent < 0 ? '<−1,000,000%' : '>1,000,000%';
  if (percent !== 0 && Math.abs(percent) < 0.01) return percent < 0 ? '>−0.01%' : '<0.01%';
  return `${percent.toFixed(2)}%`;
}

export interface EarnCatalogObserver {
  onCatalog: (catalog: EarnCatalog) => void;
  onState: (state: 'loading' | 'ready' | 'error') => void;
}
/** One bounded polling lifecycle; caller stops it on blur/background/unmount. */
export function observeEarnCatalog(
  load: (signal: AbortSignal) => Promise<EarnCatalog>,
  options: EarnCatalogObserver,
): () => void {
  let stopped = false;
  let request: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let aging: ReturnType<typeof setInterval> | undefined;
  const poll = async () => {
    const current = new AbortController();
    request = current;
    const ownDeadline = setTimeout(() => {
      current.abort();
      if (!stopped) options.onState('error');
    }, 5000);
    deadline = ownDeadline;
    try {
      const catalog = await load(current.signal);
      if (stopped || current.signal.aborted) return;
      clearInterval(aging);
      const received = performance.now();
      const update = () =>
        options.onCatalog(ageEarnCatalog(catalog, Math.max(0, performance.now() - received)));
      update();
      aging = setInterval(update, 1000);
      options.onState('ready');
    } catch {
      if (!stopped) options.onState('error');
    } finally {
      clearTimeout(ownDeadline);
      if (!stopped) retry = setTimeout(poll, 25000 + Math.random() * 10000);
    }
  };
  options.onState('loading');
  void poll();
  return () => {
    stopped = true;
    request?.abort();
    clearTimeout(retry);
    clearTimeout(deadline);
    clearInterval(aging);
  };
}
