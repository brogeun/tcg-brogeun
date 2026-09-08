export function initScreenMode({ arena, button, onPause }) {
  let expanded = false, busy = false, usedNative = false, transition = 0;
  let viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
  const portrait = matchMedia('(orientation: portrait)');
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  function update() {
    arena.classList.toggle('expanded', expanded);
    document.body.classList.toggle('game-expanded', expanded);
    button.setAttribute('aria-pressed', String(expanded));
    button.setAttribute('aria-label', expanded ? '확대 화면 닫기' : '게임 화면 확대');
    button.title = expanded ? '원래 화면으로 돌아가기' : '전체화면으로 크게 플레이';
    button.querySelector('span').textContent = expanded ? '축소' : '확대';
  }
  function restore() {
    transition++; expanded = false; busy = false; usedNative = false;
    try { screen.orientation?.unlock?.(); } catch {}
    update(); onPause();
    if (!document.hidden) button.focus({ preventScroll: true });
  }
  async function leaveNative() {
    if (fullscreenElement() !== arena) return;
    try {
      const leave = document.exitFullscreen || document.webkitExitFullscreen;
      if (leave) await leave.call(document);
    } catch {}
  }
  async function exit() {
    const request = ++transition;
    busy = true; onPause();
    await leaveNative();
    if (request !== transition) return;
    // An exit refusal must leave the close button usable in the native view.
    if (fullscreenElement() === arena) { busy = false; return; }
    restore();
  }
  button.addEventListener('click', async () => {
    if (busy) return;
    if (expanded) { await exit(); return; }
    const request = ++transition;
    busy = true;
    try {
      expanded = true; onPause(); update();
      const enter = arena.requestFullscreen || arena.webkitRequestFullscreen;
      const allowed = document.fullscreenEnabled ?? document.webkitFullscreenEnabled;
      if (enter && allowed !== false) {
        try { await enter.call(arena); } catch {}
      }
      // Escape can cancel while the browser is still resolving its request.
      if (request !== transition) {
        if (!expanded) await leaveNative();
        return;
      }
      usedNative = fullscreenElement() === arena;
      // Browsers without fullscreen support still get a viewport-filling game.
      if (expanded && usedNative && screen.orientation?.lock) {
        try { await screen.orientation.lock('landscape'); } catch {}
        if (request !== transition) {
          try { screen.orientation.unlock?.(); } catch {}
          return;
        }
      }
      update();
    } finally { if (request === transition) busy = false; }
  });
  function fullscreenChanged() {
    if (fullscreenElement() === arena) {
      if (expanded) usedNative = true;
      else void leaveNative();
    }
    else if (usedNative) restore();
  }
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('webkitfullscreenchange', fullscreenChanged);
  portrait.addEventListener('change', () => { onPause(); update(); });
  window.addEventListener('resize', () => {
    if (window.innerWidth === viewportWidth && window.innerHeight === viewportHeight) return;
    viewportWidth = window.innerWidth; viewportHeight = window.innerHeight;
    onPause(); update();
  });
  document.addEventListener('keydown', event => {
    if (expanded && event.code === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); void exit();
    }
  }, true);
  update();
  return { canPlay: () => !busy && !document.hidden && (!expanded || !portrait.matches) };
}
