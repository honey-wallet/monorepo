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
export function leaveSheetTo(href: Href) {
  router.dismiss();
  router.push(href);
}
