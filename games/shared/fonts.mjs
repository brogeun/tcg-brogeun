const FALLBACK_FAMILY = 'system-ui, sans-serif';
let family, sourceBody, viewportWidth;

// Canvas does not inherit CSS typography; read the same responsive family as the page.
export function refreshCanvasFont() {
  sourceBody = globalThis.document?.body;
  viewportWidth = globalThis.innerWidth;
  family = sourceBody && typeof globalThis.getComputedStyle === 'function'
    ? globalThis.getComputedStyle(sourceBody).fontFamily.trim() || FALLBACK_FAMILY
    : FALLBACK_FAMILY;
  return family;
}

export function canvasFont(size, weight = 400) {
  if (!family || sourceBody !== globalThis.document?.body || viewportWidth !== globalThis.innerWidth) refreshCanvasFont();
  return `${weight} ${size}px ${family}`;
}
