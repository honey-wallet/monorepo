import { type Href, router } from 'expo-router';

/**
 * Goes back, or to `fallback` when there's nothing to go back to (the screen was
 * opened directly, e.g. from a deep link).
 */
export function goBackOr(fallback: Href) {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/**
 * From a sheet, opens a full screen: closes the sheet first, then pushes. Replacing
 * the sheet instead would show the screen inside the sheet's card (grey band, rounded
 * top, doubled status-bar gap).
 */
export function leaveSheetTo(href: Href, { navigate = false }: { navigate?: boolean } = {}) {
  router.dismiss();
  // Open the next screen once the sheet or tray has gone: a tray holds its removal
  // for its exit animation, and pushing during it got the push undone.
  setTimeout(() => (navigate ? router.navigate(href) : router.push(href)), SHEET_EXIT);
}

/** Long enough for a tray's or sheet's exit to finish. */
export const SHEET_EXIT = 230;
