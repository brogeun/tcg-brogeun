/* Standalone game documents do not run index.html's native initialization. */
(() => {
  const apply = () => {
    const native = window.Capacitor;
    if (!native?.isNativePlatform?.()) return false;
    document.documentElement.dataset.gamePlatform = native.getPlatform?.() || 'native';
    return true;
  };
  if (apply()) return;
  // The bridge may be injected after the standalone document has loaded.
  let attempts = 0;
  const timer = setInterval(() => {
    if (apply() || ++attempts >= 20) clearInterval(timer);
  }, 250);
})();
