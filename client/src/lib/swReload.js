// Force the page to reload once a new service worker takes control, so
// updates apply on first load instead of needing a manual close/reopen twice.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}
