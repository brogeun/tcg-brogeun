// The title is usable before any game data, 3D engine or account request starts.
(() => {
  const message = document.getElementById('load-message');
  if (!message) return;
  const entry = document.getElementById('kanto-runtime');
  // Retain recovery for older cached HTML whose module entry still starts eagerly.
  if (!entry) {
    if (window.__kantoStartupState === 'ready') return;
    let timer = null, ready = false;
    function complete() {
      ready = true; clearTimeout(timer);
      document.getElementById('startup-recovery')?.remove();
    }
    function failure(detail) {
      if (ready || window.__kantoStartupState === 'ready') return;
      message.textContent = detail || '탐험 화면을 불러오는 데 시간이 걸리고 있습니다. 연결을 확인한 뒤 다시 불러와 주세요.';
      if (document.getElementById('startup-recovery')) return;
      const actions = document.createElement('div'); actions.id = 'startup-recovery';
      const retry = document.createElement('button'); retry.className = 'start-primary'; retry.textContent = '다시 불러오기'; retry.onclick = () => location.reload();
      const home = document.createElement('a'); home.href = '/'; home.textContent = 'TCG HUB로 돌아가기';
      actions.append(retry, home); message.parentElement.append(actions);
    }
    window.addEventListener('kanto151-ready', complete, {once: true});
    window.addEventListener('kanto151-startup-error', event => failure(event.detail));
    window.addEventListener('error', event => {
      if (event.target?.tagName === 'SCRIPT' && event.target.type === 'module') failure('게임 파일을 불러오지 못했습니다. 다시 불러와 주세요.');
    }, true);
    timer = setTimeout(() => failure(), 30000);
    if (window.__kantoStartupState === 'failed') failure(window.__kantoStartupError);
    return;
  }
  const byId = id => document.getElementById(id);
  const qaMode = new URLSearchParams(location.search).get('qa') === '1';
  const regions = {
    verdant: ['푸른잎 탐험지', 'Verdant Expedition'], waterside: ['물빛 해안', 'Waterside Coast'],
    highlands: ['달오름 산맥', 'Moonrise Highlands'], caldera: ['잿불 분화구', 'Ember Caldera'], complex: ['폐허 연구단지', 'Ruined Research Complex'],
  };
  const oldRegions = {camp:'verdant',grassland:'verdant',forest:'verdant',safari:'verdant',lake:'waterside',coast:'waterside',wetland:'waterside',mountain:'highlands',cave:'highlands',frozen:'highlands',volcano:'caldera',ruins:'complex',powerplant:'complex',laboratory:'complex'};
  const text = {
    'start.brand':['관동도감','Kanto Pokédex'], 'start.edition':['KANTO 151','KANTO 151'],
    'start.preparing':['탐험을 준비하고 있어요','Preparing your expedition'], 'start.record':['탐험 기록','Expedition record'],
    'start.settings':['설정','Settings'], 'start.credits':['게임 안내','Game info'],
    'start.registered':['도감에 등록한 포켓몬','Pokémon registered'],
  };
  function localSummary() {
    // QA must not even read the user's real storage. The full runtime retains
    // responsibility for validation/migration; this preview never writes a save.
    if (qaMode) return null;
    let storage; try { storage = globalThis.localStorage; } catch { return null; }
    for (const key of ['tcghub:kanto151:v3','tcghub:kanto151:v3:backup','tcghub:kanto151:v2','tcghub:kanto151:v2:backup']) {
      try {
        const raw = storage?.getItem(key); if (!raw) continue;
        const save = JSON.parse(raw);
        if (!save || typeof save !== 'object' || save.version > 3 || !Array.isArray(save.collection) || !Array.isArray(save.party) || !save.dex || typeof save.dex !== 'object' || Array.isArray(save.dex)) continue;
        if (save.starter !== null && ![1,4,7,25].includes(save.starter)) continue;
        if (save.starter && (!save.party.length || save.party.length > 6)) continue;
        const count = Object.entries(save.dex).filter(([id,value]) => Number.isInteger(Number(id)) && Number(id)>=1 && Number(id)<=151 && value?.caught === true).length;
        return {saved:Boolean(save.starter),locale:save.settings?.locale==='en-US'?'en-US':'ko-KR',region:oldRegions[save.region]||save.region,count};
      } catch { /* A damaged primary can still have a readable backup. */ }
    }
    return null;
  }
  const summary = localSummary(), english = summary?.locale === 'en-US', language = english ? 1 : 0;
  const copy = (ko,en) => english ? en : ko;
  document.documentElement.lang = english ? 'en-US' : 'ko-KR';
  document.querySelectorAll('[data-start-text]').forEach(el => { const value=text[el.dataset.startText]; if (value) el.textContent=value[language]; });
  document.querySelectorAll('[data-start-label]').forEach(el => { const value=text[el.dataset.startLabel]; if (value) el.setAttribute('aria-label',value[language]); });
  const hasSave = Boolean(summary?.saved);
  byId('start-heading').textContent = hasSave ? copy('탐험을 이어가세요','Continue your expedition') : copy('첫 파트너를 등록하세요','Register your first partner');
  byId('start-description').textContent = hasSave ? copy('함께하던 친구들이 기다리고 있어요.','Your friends are ready to travel again.') : copy('함께할 친구를 고르면 탐험을 시작합니다.','Choose a friend to begin your expedition.');
  byId('start-save').classList.toggle('hidden',!hasSave); byId('start-lineup').classList.toggle('hidden',hasSave);
  byId('start-region').textContent = regions[summary?.region]?.[language] || '';
  const count = document.createTextNode(String(summary?.count || 0).padStart(3,'0')+' '), total = document.createElement('small'); total.textContent='/ 151';
  byId('title-count').replaceChildren(count,total);
  const continueButton = byId('continue'), newButton = byId('new-game');
  continueButton.classList.remove('hidden'); continueButton.disabled=!hasSave;
  continueButton.classList.toggle('start-primary',hasSave); continueButton.classList.toggle('start-secondary',!hasSave);
  continueButton.textContent=copy('탐험 이어하기','Continue expedition');
  newButton.classList.toggle('start-primary',!hasSave); newButton.classList.toggle('start-secondary',hasSave);
  newButton.textContent=hasSave ? copy('새 탐험 시작','New expedition') : copy('파트너 고르기','Choose a partner');
  byId('hub-return')?.setAttribute('aria-label',copy('TCG HUB 홈으로 돌아가기','Return to TCG HUB'));
  byId('loading').classList.add('hidden'); byId('title').classList.remove('hidden');
  let accountShell = byId('startup-account-shell');
  if (!qaMode && !accountShell) {
    accountShell=document.createElement('div'); accountShell.id='startup-account-shell'; accountShell.className='account-save-title';
    const accountStatus=document.createElement('small'); accountStatus.id='startup-account-status'; accountStatus.textContent=copy('계정에 보관한 탐험은 여기서 확인하세요.','Check an expedition saved to your account.');
    const accountButton=document.createElement('button'); accountButton.id='startup-account-open'; accountButton.type='button'; accountButton.textContent=copy('계정 기록 확인','Account save');
    accountShell.append(accountStatus,accountButton); byId('title-actions').after(accountShell);
  }
  if (qaMode) accountShell?.remove();
  let state='idle', pending=null, script=null, timer=null;
  window.__kantoStartupState='idle';
  function busy(value) {
    document.querySelectorAll('#title button').forEach(button => { button.disabled=value || (button.id==='continue'&&!hasSave); });
    byId('title').setAttribute('aria-busy',String(value));
  }
  function showFailure(detail) {
    if (state==='ready') return;
    state='failed'; clearTimeout(timer);
    window.__kantoStartupState='failed';
    window.__kantoStartupError=detail || copy('탐험 화면을 불러오는 데 시간이 걸리고 있습니다. 연결을 확인한 뒤 다시 불러와 주세요.','Loading is taking longer than expected. Check your connection and reload.');
    message.textContent=window.__kantoStartupError;
    byId('loading').classList.remove('hidden'); byId('title').classList.add('hidden');
    if (byId('startup-recovery')) return;
    const actions=document.createElement('div'); actions.id='startup-recovery';
    const retry=document.createElement('button'); retry.className='start-primary'; retry.type='button'; retry.textContent=copy('다시 불러오기','Reload'); retry.onclick=()=>location.reload();
    const home=document.createElement('a'); home.href='/'; home.textContent=copy('TCG HUB로 돌아가기','Return to TCG HUB');
    actions.append(retry,home); message.parentElement.append(actions);
  }
  function loadRuntime(intent) {
    if (state!=='idle') return;
    pending=intent; state='loading'; window.__kantoStartupState='loading'; busy(true);
    byId('loading').classList.remove('hidden'); byId('title').classList.add('hidden');
    message.textContent=copy('탐험에 필요한 파일을 준비하고 있어요…','Preparing the files for your expedition…');
    const source=entry.dataset.runtimeSrc;
    if (!source) { showFailure(copy('게임 파일 경로를 찾지 못했습니다. 다시 불러와 주세요.','The game entry is missing. Please reload.')); return; }
    script=document.createElement('script'); script.type='module'; script.src=source; script.dataset.startupRuntime='true';
    script.onerror=()=>showFailure(copy('게임 파일을 불러오지 못했습니다. 다시 불러와 주세요.','The game file could not be loaded. Please reload.'));
    timer=setTimeout(()=>showFailure(),30000);
    document.body.append(script);
  }
  function intentClick(event) {
    if (state==='ready') return;
    const button=event.target?.closest?.('#new-game,#continue,#title [data-panel],#startup-account-open');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (state!=='idle' || button.disabled) return;
    if (button.id==='new-game') loadRuntime({type:'new'});
    else if (button.id==='continue') loadRuntime({type:'continue'});
    else if (button.id==='startup-account-open') loadRuntime({type:'account'});
    else if (['settings','credits'].includes(button.dataset.panel)) loadRuntime({type:'panel',panel:button.dataset.panel});
  }
  document.addEventListener('click',intentClick,true);
  window.addEventListener('kanto151-startup-error',event=>showFailure(event.detail));
  window.addEventListener('error',event=>{if (script && event.target===script) script.onerror();},true);
  window.addEventListener('kanto151-ready',()=>{
    if (state==='ready') return;
    const runtime=window.kanto151;
    if (!runtime?.game) { showFailure(copy('탐험을 시작하지 못했습니다. 다시 불러와 주세요.','The game could not be started. Please reload.')); return; }
    state='ready'; window.__kantoStartupState='ready'; clearTimeout(timer); byId('startup-recovery')?.remove();
    accountShell?.remove(); document.removeEventListener('click',intentClick,true);
    byId('loading').classList.add('hidden'); byId('title').setAttribute('aria-busy','false');
    const intent=pending; pending=null;
    if (intent?.type==='new') newButton.click();
    else if (intent?.type==='continue') continueButton.click();
    else if (intent?.type==='panel') runtime.game.openPanel(intent.panel);
    else if (intent?.type==='account') runtime.game.accountSaveUI?.open();
  });
})();
