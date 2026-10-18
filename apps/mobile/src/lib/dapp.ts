import type { Answer, Approval, Site } from '@honey-wallet/extension/protocol';

/**
 * Talking to Honey for Chrome's background worker (websites, connected sites, the
 * toolbar badge). Only the browser build has one; on a phone these do nothing.
 */

/** Whether this page can talk to the extension's worker. */
export const hasWorker = false;

/** The oldest website request waiting for an answer, or null. */
export async function nextApproval(): Promise<Approval | null> {
  return null;
}

export async function answerApproval(_answer: Answer): Promise<boolean> {
  return false;
}

export async function connectedSites(): Promise<Site[]> {
  return [];
}

export async function disconnectSite(_origin: string) {}

/** Sign out or reset: no site stays connected to wallets that are gone. */
export async function forgetSites() {}

/** Keeps the worker awake while an approval is open. */
export function keepWorkerAwake(): () => void {
  return () => {};
}

/** Shared-wallet proposals waiting for you, for the toolbar badge. */
export function publishWaiting(_count: number) {}
