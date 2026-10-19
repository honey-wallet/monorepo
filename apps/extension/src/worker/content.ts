import {
  ERR,
  FROM_CONTENT,
  FROM_PAGE,
  type PageReply,
  type PageRequest,
  PORT_NAME,
} from './protocol';

/**
 * Runs beside every page (in Chrome's isolated world) and only passes messages:
 * page calls go to the background worker over a port, and its answers and events come
 * back. It reads nothing from the page and adds nothing to it.
 */

let port: chrome.runtime.Port | null = null;
const inFlight = new Set<number>();
const MAX_IN_FLIGHT = 32;
const MAX_REQUEST_BYTES = 128 * 1024;

const toPage = (message: PageReply) =>
  window.postMessage({ source: FROM_CONTENT, ...message }, window.location.origin);

function connect() {
  if (port) return port;
  const next = chrome.runtime.connect({ name: PORT_NAME });
  next.onMessage.addListener((message: PageReply) => {
    if ('id' in message) inFlight.delete(message.id);
    toPage(message);
  });
  // The worker restarted (or the extension updated): fail what was waiting, reconnect later.
  next.onDisconnect.addListener(() => {
    port = null;
    for (const id of inFlight) toPage({ id, error: ERR.disconnected });
    inFlight.clear();
  });
  port = next;
  return next;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as (PageRequest & { source?: string }) | undefined;
  if (data?.source !== FROM_PAGE || !Number.isSafeInteger(data.id) || data.id < 0) return;
  const request: PageRequest = {
    id: data.id,
    namespace: data.namespace === 'solana' ? 'solana' : 'evm',
    method: String(data.method),
    params: data.params,
  };
  let serializedBytes: number;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  } catch {
    toPage({ id: request.id, error: ERR.invalid });
    return;
  }
  if (serializedBytes > MAX_REQUEST_BYTES) {
    toPage({ id: request.id, error: ERR.invalid });
    return;
  }
  if (inFlight.has(request.id) || inFlight.size >= MAX_IN_FLIGHT) {
    toPage({ id: request.id, error: ERR.busy });
    return;
  }
  try {
    inFlight.add(request.id);
    connect().postMessage(request);
  } catch {
    // The extension was reloaded; this page needs a refresh to talk to it again.
    inFlight.delete(request.id);
    toPage({ id: request.id, error: ERR.disconnected });
  }
});

// Sites learn about account and network changes even before they call anything.
try {
  connect();
} catch {
  // Reloaded extension: nothing to do until the page refreshes.
}
