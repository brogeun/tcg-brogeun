// A classic script can report module-loading failures instead of leaving a disabled start button.
(() => {
  const start = document.getElementById('start');
  const title = document.getElementById('overlay-title');
  const copy = document.getElementById('overlay-copy');
  if (location.protocol === 'file:') {
    title.textContent = '미리보기에서 게임을 열어주세요';
    copy.textContent = '파일을 직접 열면 게임을 실행할 수 없어요. 실행 중인 로컬 미리보기로 이동하세요.';
    start.disabled = false; start.textContent = '게임 미리보기 열기';
    start.onclick = () => location.assign('http://127.0.0.1:8765/games/volleyball/');
    return;
  }
  const failure = () => {
    title.textContent = '게임을 불러오지 못했어요';
    copy.textContent = '연결을 확인하고 다시 불러오기를 눌러 주세요.';
    start.disabled = false; start.textContent = '다시 불러오기';
    start.onclick = () => location.reload();
  };
  const timer = setTimeout(failure, 15000);
  import('./game.js?v=15').then(() => clearTimeout(timer)).catch(error => {
    clearTimeout(timer); console.error('Volleyball startup failed:', error); failure();
  });
})();
