/** Register the app-shell service worker. Owner screens only. */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    // Scope-relative so it works both at a domain root and under /<repo>/ on
    // GitHub Pages project sites.
    const base = location.pathname.replace(/[^/]*$/, '');
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      /* offline support is a bonus, never a hard requirement */
    });
  });
}
