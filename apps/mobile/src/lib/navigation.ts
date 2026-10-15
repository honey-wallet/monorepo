import { type Href, router } from 'expo-router';

/**
 * Goes back, or to `fallback` when there's nothing to go back to (the screen was
 * opened directly, e.g. from a deep link).
 */
export function goBackOr(fallback: Href) {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
