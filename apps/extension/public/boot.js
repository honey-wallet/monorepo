// Runs before the app. The router reads the page's path, and an extension page's path
// is /index.html, so start it at the app's root (or the route a window was opened
// for, e.g. an approval). The toolbar popup is opened with ?popup and gets a fixed size.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.has('popup')) document.documentElement.classList.add('popup');
  const route = params.get('route') ?? '';
  // A path (and query) inside the app only: replaceState can't leave the extension's origin.
  const safe = /^[\w\-./?=&%]*$/.test(route) ? route.replace(/^\/+/, '') : '';
  history.replaceState(null, '', `/${safe}`);
})();
