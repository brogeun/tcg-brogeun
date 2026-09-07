export function initScreenMode({ arena, button, onPause }) {
  let expanded = false, busy = false, usedNative = false;
  const portrait = matchMedia('(orientation: portrait)');
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  function update() {
    arena.classList.toggle('expanded', expanded);
    document.body.classList.toggle('game-expanded', expanded);
    button.setAttribute('aria-pressed', String(expanded));
    button.setAttribute('aria-label', expanded ? '확대 화면 닫기' : '게임 화면 확대');
    button.title = expanded ? '원래 화면으로 돌아가기' : '전체화면으로 크게 플레이';
    button.querySelector('span').textContent = expanded ? '축소' : '확대';
    if (expanded && portrait.matches) onPause();
  }
  function restore() {
    expanded = false; usedNative = false;
    try { screen.orientation?.unlock?.(); } catch {}
    update(); onPause(); button.focus({ preventScroll: true });
  }
  async function exit() {
    if (fullscreenElement() === arena) {
      try {
        const leave = document.exitFullscreen || document.webkitExitFullscreen;
        if (leave) await leave.call(document);
      } catch {}
      if (fullscreenElement() === arena) return;
    }
    restore();
  }
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      if (expanded) { await exit(); return; }
      expanded = true; onPause(); update();
      const enter = arena.requestFullscreen || arena.webkitRequestFullscreen;
      const allowed = document.fullscreenEnabled ?? document.webkitFullscreenEnabled;
      if (enter && allowed !== false) {
        try { await enter.call(arena); usedNative = fullscreenElement() === arena; } catch {}
      }
      // Browsers without fullscreen support still get a viewport-filling game.
      if (expanded && usedNative && screen.orientation?.lock) {
        try { await screen.orientation.lock('landscape'); } catch {}
      }
      update();
    } finally { busy = false; }
  });
  function fullscreenChanged() {
    if (fullscreenElement() === arena) usedNative = true;
    else if (usedNative) restore();
  }
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('webkitfullscreenchange', fullscreenChanged);
  portrait.addEventListener('change', update);
  document.addEventListener('keydown', event => {
    if (expanded && event.code === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); void exit();
    }
  }, true);
  update();
  return { canPlay: () => !expanded || !portrait.matches };
}
