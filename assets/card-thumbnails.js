/* Explicit list-only SNKRDUNK thumbnails; detail artwork keeps its original URL. */
(() => {
  'use strict';
  const selector = [
    '#homeTopPokemon .card-img-thumb img', '#homeTopOnepiece .card-img-thumb img',
    '[data-home-top-list] img', '.set-tile-img img', '.price-card-img img', '.gs-row > img.gs-thumb',
    '.set-card-grid .set-card-img img', '.tci-grid .tci-art img', '.tci-set .tci-cover img',
    'img[data-card-thumbnail]',
  ].join(',');
  const excluded = [
    '#slideCardImg', '#slidePanel', '#priceDetailPanel', '#priceDetail',
    '.ci-card-detail', '.tci-detail', '.tci-art-large', '.enc-detail', '.enc-art',
    '.px-detail', '.px-art', '#cr-evidence-dialog', '[data-full-image]',
    '[data-original-only]', '[data-thumbnail-disabled]',
  ].join(',');
  const states = new WeakMap(), originals = new Map(), MAX_ORIGINALS = 512;

  function smaller(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'cdn.snkrdunk.com' ||
          url.username || url.password || (url.port && url.port !== '443') ||
          !/^\/upload_bg_removed\/[a-z0-9._-]+\.(?:webp|png|jpe?g)$/i.test(url.pathname) ||
          url.searchParams.getAll('size').length !== 1 || url.searchParams.get('size') !== 'l') return '';
      // The provider's literal size=l is 856px; size=m is 398px. Preserve every
      // other query byte and fragment, including potentially signed parameters.
      if (!/[?&]size=l(?=&|#|$)/.test(value)) return '';
      return value.replace(/([?&])size=l(?=&|#|$)/, '$1size=m');
    } catch { return ''; }
  }

  function remember(thumbnail, original) {
    const variants = new Set([thumbnail, new URL(thumbnail).href]);
    for (const variant of variants) {
      originals.delete(variant); originals.set(variant, original);
    }
    while (originals.size > MAX_ORIGINALS) originals.delete(originals.keys().next().value);
  }

  const source = image => image?.getAttribute?.('src') || image?.src || '';
  function original(value) {
    if (typeof value === 'string') return originals.get(value) || value;
    const displayed = window.CardArtwork?.proxyOriginal?.(value);
    if (displayed) return displayed;
    const current = source(value), saved = value?.getAttribute?.('data-original-src');
    const state = states.get(value);
    if (state && (current === state.thumbnail || current === state.original)) return state.original;
    // The element carries its original even after the bounded reverse URL map
    // evicts an older entry. Do not mistake an unrelated fallback for that image.
    if (saved && (current === saved || smaller(saved) === current)) return saved;
    return current;
  }

  const escapeAttribute = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function attributes(value) {
    const original = typeof value === 'string' ? value : '';
    const thumbnail = smaller(original);
    if (thumbnail) remember(thumbnail, original);
    return 'src="' + escapeAttribute(thumbnail || original) + '"' +
      (thumbnail ? ' data-original-src="' + escapeAttribute(original) + '"' : '');
  }

  function apply(root = globalThis.document) {
    if (!root) return 0;
    const images = [...(root.matches?.(selector) ? [root] : []), ...(root.querySelectorAll?.(selector) || [])];
    let changed = 0;
    for (const image of images) {
      if (image.tagName !== 'IMG' || !image.matches?.(selector) || image.closest?.(excluded) ||
          image.hasAttribute?.('srcset')) continue;
      const current = source(image), prior = states.get(image);
      if (prior && (current === prior.thumbnail || current === prior.original)) continue;
      // Templates may already select size=m before the browser sees an src.
      // Attach the same original/error state without reassigning that src.
      const saved = image.getAttribute('data-original-src');
      const preselected = saved && smaller(saved) === current;
      const fullSource = preselected ? saved : current;
      if (image.parentElement?.classList?.contains('set-card-img') && image.parentElement.closest('.set-card-grid') &&
          fullSource !== image.getAttribute('data-artwork-direct')) {
        const gridURL = window.CardArtwork?.gridURL?.(fullSource);
        if (gridURL && gridURL !== fullSource) {
          image.setAttribute('data-artwork-original', fullSource);
          image.setAttribute('src', gridURL);
          changed++;
          continue;
        }
      }
      const thumbnail = preselected ? current : smaller(current);
      if (!thumbnail) continue;
      const previous = prior && image.onerror === prior.handler ? prior.previous : image.onerror;
      const state = {original: fullSource, thumbnail, retried: false, previous};
      states.set(image, state);
      image.setAttribute('data-original-src', fullSource);
      state.handler = function(event) {
        const active = states.get(image);
        if (active === state && !active.retried && source(image) === active.thumbnail) {
          active.retried = true;
          image.setAttribute('src', active.original);
          return;
        }
        if (typeof state.previous === 'function') return state.previous.call(image, event);
      };
      image.onerror = state.handler;
      remember(thumbnail, fullSource);
      if (current !== thumbnail) {
        image.setAttribute('src', thumbnail);
        changed++;
      }
    }
    return changed;
  }

  // No initial scan, observer, timer, image prefetch or route listener is installed.
  window.CardThumbnails = Object.freeze({apply, original, attributes, selector, smaller});
})();
