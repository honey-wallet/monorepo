import {
  type Answer,
  type AppMessage,
  type Approval,
  type Site,
  STORAGE,
} from '@honey-wallet/extension/protocol';

/** The few chrome.* calls the app makes, typed here so the app needn't load @types/chrome. */
type Chrome = {
  runtime?: { id?: string; sendMessage: (message: AppMessage) => Promise<unknown> };
  storage?: { local: { set: (items: Record<string, unknown>) => Promise<void> } };
};
const chrome = (globalThis as { chrome?: Chrome }).chrome;

/** True inside the extension; false when the app runs in a plain browser tab (expo start --web). */
export const hasWorker = !!chrome?.runtime?.id;

async function send<T>(message: AppMessage, fallback: T): Promise<T> {
  if (!hasWorker || !chrome?.runtime) return fallback;
  try {
    return ((await chrome.runtime.sendMessage(message)) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export const nextApproval = () => send<Approval | null>({ type: 'honey:next' }, null);

export const answerApproval = (answer: Answer) =>
  send<boolean>({ type: 'honey:answer', answer }, false);

export const connectedSites = () => send<Site[]>({ type: 'honey:sites' }, []);

export const disconnectSite = (origin: string) =>
  send<boolean>({ type: 'honey:disconnect', origin }, false);

export const forgetSites = () => send<boolean>({ type: 'honey:forget' }, false);

/** The toolbar popup (boot.js marks it), as opposed to Honey's own window or a tab. */
export const inPopup =
  typeof document !== 'undefined' && document.documentElement.classList.contains('popup');

/** From the popup: the same screen in Honey's phone-sized window, then the popup closes. */
export async function expandView() {
  const route = `${location.pathname.replace(/^\/+/, '')}${location.search}`;
  await send<boolean>({ type: 'honey:expand', route }, false);
  window.close();
}

/** Chrome stops an idle worker after ~30s; an open approval pings it so nothing is lost. */
export function keepWorkerAwake() {
  const timer = setInterval(() => void send({ type: 'honey:ping' }, null), 20_000);
  return () => clearInterval(timer);
}

let lastWaiting = -1;
export function publishWaiting(count: number) {
  if (!hasWorker || count === lastWaiting) return;
  lastWaiting = count;
  void chrome?.storage?.local.set({ [STORAGE.waiting]: count }).catch(() => {});
}
