/**
 * Messages between a website and Honey for Chrome:
 *
 *   page (inpage.ts) ⇄ window.postMessage ⇄ content.ts ⇄ port ⇄ background.ts
 *                                                                  ⇅ runtime messages
 *                                          the app's approval window (approve.tsx)
 *
 * The background worker never trusts what a page says about itself: the origin comes
 * from Chrome (the port's sender), and only Honey's own pages may answer requests.
 */

export const FROM_PAGE = 'honey-inpage';
export const FROM_CONTENT = 'honey-content';
export const PORT_NAME = 'honey-page';

export type Namespace = 'evm' | 'solana';

/** A call from a website. Binary data (Solana) travels as base64. */
export type PageRequest = { id: number; namespace: Namespace; method: string; params?: unknown };

export type ProviderError = { code: number; message: string; data?: unknown };

export type PageReply =
  | { id: number; result: unknown }
  | { id: number; error: ProviderError }
  | { event: string; namespace: Namespace; data: unknown };

/** EIP-1193 / EIP-1474 error codes, with the messages sites show. */
export const ERR = {
  rejected: { code: 4001, message: 'You cancelled this in Honey.' },
  unauthorized: { code: 4100, message: 'Connect Honey to this site first.' },
  unsupported: { code: 4200, message: 'Honey doesn’t support this request.' },
  disconnected: { code: 4900, message: 'Honey isn’t connected. Try again.' },
  unknownChain: { code: 4902, message: 'Honey doesn’t support this network yet.' },
  pending: { code: -32002, message: 'Honey is already asking about this. Open Honey to answer.' },
  busy: { code: -32005, message: 'Too many requests. Answer the ones in Honey first.' },
  invalid: { code: -32602, message: 'Invalid request.' },
  internal: { code: -32603, message: 'Something went wrong in Honey.' },
} satisfies Record<string, ProviderError>;

/** A connected site: which wallet it sees, and the EVM network it's on. */
export type Site = {
  origin: string;
  walletId: string;
  walletName: string;
  /** Null when the wallet has no address there (a Solana shared wallet has no EVM one). */
  evm: string | null;
  solana: string | null;
  chainId: number;
  connectedAt: number;
};

/** Public key-backed wallet metadata, shared by the worker and native WalletConnect. */
export type SiteWallet = {
  id: string;
  kind: string;
  watchOnly?: boolean;
  addresses?: { evm?: string; solana?: string };
};

/** Cached site permissions must still name addresses whose keys the wallet holds. */
export function siteMatchesWallet(site: Site, wallet: SiteWallet | undefined): boolean {
  return (
    !!wallet &&
    wallet.id === site.walletId &&
    wallet.kind === 'wallet' &&
    !wallet.watchOnly &&
    !!wallet.addresses &&
    !!(site.evm || site.solana) &&
    (!site.evm || site.evm.toLowerCase() === wallet.addresses.evm?.toLowerCase()) &&
    (!site.solana || site.solana === wallet.addresses.solana)
  );
}

export type ApprovalKind =
  | 'connect'
  | 'switchChain'
  | 'evmSign'
  | 'evmTypedData'
  | 'evmSend'
  | 'solanaSignMessage'
  | 'solanaSignTransaction'
  | 'solanaSend';

/** Something waiting for the user's answer in the approval window. */
export type Approval = {
  id: string;
  kind: ApprovalKind;
  origin: string;
  /** The tab's icon, to show beside the origin. */
  icon?: string;
  /**
   * WalletConnect only: whether its Verify service confirmed the site owns the domain it
   * claims. A browser site's origin comes from Chrome, so it has none.
   */
  verified?: 'valid' | 'invalid' | 'unknown' | 'scam';
  /** The site's connection, for everything but `connect`. */
  site?: Site;
  /** For `switchChain` the chain id; otherwise the call's own params (see approve.tsx). */
  params: unknown;
  createdAt: number;
};

/** What the approval window sends back for a request. */
export type Answer =
  | { id: string; result: unknown }
  | { id: string; error: ProviderError }
  /** `connect`: the wallet the user picked. */
  | { id: string; connect: Pick<Site, 'walletId' | 'walletName' | 'evm' | 'solana'> };

/** Messages only Honey's own pages may send the worker. */
export type AppMessage =
  | { type: 'honey:next' }
  /** UI claims a still-pending request after owner confirmation, before side effects. */
  | { type: 'honey:claim'; id: string }
  | { type: 'honey:answer'; answer: Answer }
  | { type: 'honey:sites' }
  | { type: 'honey:disconnect'; origin: string }
  /** Sign out or reset: disconnect every site. */
  | { type: 'honey:forget' }
  /** Keeps the worker awake while the approval window is open. */
  | { type: 'honey:ping' }
  /** The popup's Expand view: open Honey's phone-sized window at this route. */
  | { type: 'honey:expand'; route: string };

export const STORAGE = {
  sites: 'honey.sites',
  chains: 'honey.site-chains',
  approvals: 'honey.approvals',
  window: 'honey.approval-window',
  appWindow: 'honey.app-window',
  /** Shared-wallet proposals waiting for you; the app keeps it current for the badge. */
  waiting: 'honey.badge.waiting',
} as const;
