import {
  type AppMessage,
  ERR,
  type PageReply,
  type PageRequest,
  PORT_NAME,
  type ProviderError,
  STORAGE,
} from './protocol';
import { createRouter } from './router';
import { createRpcClient } from './rpc';

/**
 * Honey for Chrome's service worker: answers websites (through content.ts), keeps the
 * list of connected sites, opens the approval window and keeps the toolbar badge.
 * Keys never come here; the approval window signs.
 */

const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const ports = new Map<string, Set<chrome.runtime.Port>>();

const toError = (error: unknown): ProviderError =>
  error && typeof error === 'object' && 'code' in error && 'message' in error
    ? (error as ProviderError)
    : ERR.internal;

/**
 * Approvals and Expand view open Honey in a phone-sized window (an iPhone's 393 × 852
 * points), laid out exactly as on the phone. The toolbar button opens the usual popup
 * under it instead, 393 × 600 (Chrome caps a popup at 800 × 600). The page trims the
 * window to that inner size once it knows the frame (public/boot.js).
 */
export const PHONE = { width: 393, height: 852 } as const;
/**
 * Website approvals open at the popup's size instead (review: a phone-tall window didn't
 * read as the extension), like other wallets' approval windows.
 */
export const POPUP = { width: 393, height: 600 } as const;
type WindowSize = { width: number; height: number };
/** A first guess at the title bar, corrected by the page. */
const FRAME = 28;

/** Focuses the window kept under `key`, or opens one `inner` in size at `route`. */
async function openWindow(key: string, route: string, inner: WindowSize = PHONE) {
  const { [key]: open } = await chrome.storage.session.get(key);
  if (typeof open === 'number') {
    try {
      await chrome.windows.update(open, { focused: true });
      return;
    } catch {
      // Closed already; open a new one.
    }
  }
  const last = await chrome.windows.getLastFocused().catch(() => undefined);
  const size = {
    // boot.js trims the window to `h` inside, whatever the title bar takes.
    url: chrome.runtime.getURL(
      `index.html?window&h=${inner.height}&route=${encodeURIComponent(route)}`,
    ),
    type: 'popup' as const,
    width: inner.width,
    // On a short display, as tall as the browser window instead.
    height: Math.min(inner.height + FRAME, last?.height ?? Number.POSITIVE_INFINITY),
    focused: true,
  };
  // Beside the browser's top-right corner; Chrome refuses a spot that's mostly off-screen
  // (another monitor, a small display), so then let it pick.
  const created = await chrome.windows
    .create({
      ...size,
      left:
        last?.left !== undefined && last.width
          ? last.left + last.width - size.width - 16
          : undefined,
      top: last?.top !== undefined ? last.top + 24 : undefined,
    })
    .catch(() => chrome.windows.create(size));
  await chrome.storage.session.set({ [key]: created?.id });
}

// const openApprovals = () => openWindow(STORAGE.window, 'approve');
const openApprovals = () => openWindow(STORAGE.window, 'approve', POPUP);

// The toolbar button opens the popup under it, like other wallets (manifest
// default_popup); Expand view there opens Honey's own window ('honey:expand').
// chrome.action.onClicked.addListener(() => void openWindow(STORAGE.appWindow, ''));

const rpc = createRpcClient();

const router = createRouter({
  load: async <T>(key: string) => (await chrome.storage.local.get(key))[key] as T | undefined,
  save: (key, value) => chrome.storage.local.set({ [key]: value }),
  openApprovals,
  rpc,
  emit: (origin: string, reply: PageReply) => {
    for (const port of ports.get(origin) ?? []) {
      try {
        port.postMessage(reply);
      } catch {
        // That tab went away.
      }
    }
  },
  badge: (count) => {
    void chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : '' });
  },
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
});

void chrome.action.setBadgeBackgroundColor({ color: '#F5B82E' });
void chrome.action.setBadgeTextColor?.({ color: '#1A1408' });

// Shared-wallet proposals waiting for you count toward the badge too.
void chrome.storage.local
  .get(STORAGE.waiting)
  .then((stored) => router.setWaiting(Number(stored[STORAGE.waiting] ?? 0)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE.waiting in changes) {
    router.setWaiting(Number(changes[STORAGE.waiting]?.newValue ?? 0));
  }
});

// Websites, one port per tab, from content.ts. The origin is Chrome's, not the page's word.
chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  const origin = sender?.origin ?? (sender?.url ? new URL(sender.url).origin : '');
  if (
    port.name !== PORT_NAME ||
    sender?.id !== chrome.runtime.id ||
    !sender.tab ||
    sender.frameId !== 0 ||
    !/^https?:\/\//.test(origin)
  ) {
    port.disconnect();
    return;
  }
  const set = ports.get(origin) ?? new Set();
  set.add(port);
  ports.set(origin, set);
  port.onDisconnect.addListener(() => {
    set.delete(port);
    if (!set.size) ports.delete(origin);
  });
  port.onMessage.addListener((request: PageRequest) => {
    if (!request || typeof request.id !== 'number') return;
    const reply = (message: PageReply) => {
      try {
        port.postMessage(message);
      } catch {
        // The tab closed before we answered.
      }
    };
    router
      .fromPage(origin, sender.tab?.favIconUrl, request)
      .then((result) => reply({ id: request.id, result: result ?? null }))
      .catch((error: unknown) => reply({ id: request.id, error: toError(error) }));
  });
});

// Honey's own pages: the approval window and Settings › Connected sites.
chrome.runtime.onMessage.addListener((message: AppMessage, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.origin !== EXTENSION_ORIGIN) return false;
  const run = async () => {
    switch (message?.type) {
      case 'honey:next':
        return router.next();
      case 'honey:claim':
        return router.claim(message.id);
      case 'honey:answer':
        return router.answer(message.answer);
      case 'honey:sites':
        return router.sites();
      case 'honey:disconnect':
        await router.disconnect(message.origin);
        return true;
      case 'honey:forget':
        await router.forgetAll();
        return true;
      case 'honey:ping':
        return true;
      case 'honey:expand':
        // A path inside the app only; boot.js checks it again when the window loads.
        await openWindow(
          STORAGE.appWindow,
          typeof message.route === 'string' ? message.route.slice(0, 512) : '',
        );
        return true;
      default:
        return null;
    }
  };
  run().then(respond, () => respond(null));
  return true;
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { [STORAGE.window]: open, [STORAGE.appWindow]: app } = await chrome.storage.session.get([
    STORAGE.window,
    STORAGE.appWindow,
  ]);
  if (id === app) await chrome.storage.session.remove(STORAGE.appWindow);
  if (id !== open) return;
  await chrome.storage.session.remove(STORAGE.window);
  router.rejectAll();
});
