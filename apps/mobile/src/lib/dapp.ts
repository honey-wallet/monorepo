import type { Answer, Approval, Site } from '@honey-wallet/extension/protocol';

/**
 * Websites' requests on the phone, which arrive by WalletConnect (lib/walletconnect.ts);
 * the browser build talks to the extension's worker instead (dapp.web.ts). Loaded lazily:
 * WalletConnect starts only when something here is used.
 */

const wc = () => import('@/lib/walletconnect');

/** Whether this page is Honey for Chrome's (it closes its window when done). */
export const hasWorker = false;

/** The oldest website request waiting for an answer, or null. */
export async function nextApproval(): Promise<Approval | null> {
  return (await wc()).wcRouter.next();
}

export async function answerApproval(answer: Answer): Promise<boolean> {
  return (await wc()).wcRouter.answer(answer);
}

export async function connectedSites(): Promise<Site[]> {
  return (await wc()).wcRouter.sites();
}

export async function disconnectSite(origin: string) {
  await (await wc()).disconnectApp(origin);
}

/** Sign out: no site stays connected to wallets that are gone. */
export async function forgetSites() {
  await (await wc()).forgetApps();
}

/** Only the browser extension has a toolbar popup to expand. */
export const inPopup = false;
export async function expandView() {}

/** While the approval screen is open, new requests queue in it instead of opening another. */
export function keepWorkerAwake(): () => void {
  void wc().then((m) => m.setApprovalShowing(true));
  return () => void wc().then((m) => m.setApprovalShowing(false));
}

/** Shared-wallet proposals waiting for you: the extension's badge only. */
export function publishWaiting(_count: number) {}
