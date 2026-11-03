// This classic script can recover even when the module graph never starts main.mjs.
(() => {
  const message = document.getElementById('load-message');
  if (!message || window.__kantoStartupState === 'ready') return;
  let timer = null, ready = false;
  function complete() {
    ready = true;
    clearTimeout(timer);
    document.getElementById('startup-recovery')?.remove();
  }
  function failure(detail) {
    if (ready || window.__kantoStartupState === 'ready') return;
    message.textContent = detail || '탐험 화면을 불러오는 데 시간이 걸리고 있습니다. 연결을 확인한 뒤 다시 불러와 주세요.';
    if (document.getElementById('startup-recovery')) return;
    const actions = document.createElement('div');
    actions.id = 'startup-recovery';
    const retry = document.createElement('button');
    retry.className = 'start-primary';
    retry.textContent = '다시 불러오기';
    retry.onclick = () => location.reload();
    const home = document.createElement('a');
    home.href = '/';
    home.textContent = 'TCG HUB로 돌아가기';
    actions.append(retry, home);
    message.parentElement.append(actions);
  }
  window.addEventListener('kanto151-ready', complete, {once: true});
  window.addEventListener('kanto151-startup-error', event => failure(event.detail));
  window.addEventListener('error', event => {
    if (event.target?.tagName === 'SCRIPT' && event.target.type === 'module') failure('게임 파일을 불러오지 못했습니다. 다시 불러와 주세요.');
  }, true);
  timer = setTimeout(() => failure(), 30000);
  if (window.__kantoStartupState === 'failed') failure(window.__kantoStartupError);
})();
