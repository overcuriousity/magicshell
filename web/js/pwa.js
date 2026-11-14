// Registers the service worker that makes magicshell installable. Plain-http hosts skip it.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Installing is optional; the app works the same without it.
  });
}
