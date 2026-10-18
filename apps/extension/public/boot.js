// Runs before the app. The router reads the page's path, and an extension page's path
// is /index.html, so start it at the app's root (or the route a window was opened
// for, e.g. an approval). Honey's own windows (?window) are trimmed to a phone's inner
// size, 393 × 852, whatever the system's title bar takes.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.has('popup')) document.documentElement.classList.add('popup');
  const route = params.get('route') ?? '';
  // A path (and query) inside the app only: replaceState can't leave the extension's origin.
  const safe = /^[\w\-./?=&%]*$/.test(route) ? route.replace(/^\/+/, '') : '';
  history.replaceState(null, '', `/${safe}`);

  if (params.has('window') && typeof chrome !== 'undefined' && chrome.windows) {
    const fit = () => {
      const dw = 393 - window.innerWidth;
      const dh = 852 - window.innerHeight;
      if (!dw && !dh) return;
      chrome.windows.getCurrent((w) => {
        if (w?.id === undefined || w.state !== 'normal') return;
        chrome.windows.update(w.id, {
          width: w.width + dw,
          height: Math.min(w.height + dh, screen.availHeight),
        });
      });
    };
    window.addEventListener('load', fit, { once: true });
  }
})();
