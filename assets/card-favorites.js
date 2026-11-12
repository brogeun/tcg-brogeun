/* One card identity, server-backed toggle and star style for every detail surface. */
(() => {
  'use strict';
  const selector = 'button[data-watch-id]';
  const star = '<svg class="favorite-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>';
  let owner = null, ownerEpoch = 0, loaded = false, loading = null, busy = false;
  const userId = () => typeof CURRENT_USER !== 'undefined' && CURRENT_USER ? String(CURRENT_USER.id) : null;
  const cardId = row => String(row.card_id ?? row.snkrdunk_id ?? '');
  const rows = () => typeof WATCHLIST !== 'undefined' ? WATCHLIST : [];
  function buttonsIn(root) {
    const buttons = [];
    if (root?.matches?.(selector)) buttons.push(root);
    if (root?.querySelectorAll) buttons.push(...root.querySelectorAll(selector));
    return buttons;
  }
  function paintButtons(buttons) {
    const activeIds = userId() ? new Set(rows().map(cardId)) : new Set();
    for (const button of buttons) {
      if (button.isConnected === false) continue;
      button.classList.add('card-favorite');
      if (!button.querySelector('.favorite-icon')) button.innerHTML = star;
      const active = activeIds.has(button.dataset.watchId);
      button.setAttribute('aria-pressed', String(active));
      const label = active ? '즐겨찾기 해제' : '즐겨찾기 추가';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.disabled = busy;
    }
  }
  function sync(root = document) { paintButtons(buttonsIn(root)); }
  function updateOwner() {
    const who = userId();
    if (who !== owner) { owner = who; ownerEpoch++; loaded = false; WATCHLIST = []; }
    return who;
  }
  async function request(url, options = {}) {
    const response = await fetch(url, {...options, credentials:'include', cache:'no-store', signal:AbortSignal.timeout(10000)});
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error('즐겨찾기 요청 실패');
    return data;
  }
  async function reload() {
    const who = userId(), epoch = ownerEpoch;
    if (!who) return;
    const data = await request('/api/portfolio');
    if (who !== userId() || epoch !== ownerEpoch) throw new Error('로그인 변경');
    if (!Array.isArray(data.watchlists)) throw new Error('즐겨찾기 응답 누락');
    WATCHLIST = data.watchlists;
    owner = who; loaded = true;
    sync();
  }
  function loadIfNeeded() {
    const who = userId(), epoch = ownerEpoch;
    if (!who || loaded || loading || busy || !document.querySelector(selector)) return;
    const pending = reload().catch(() => {}).finally(() => {
      if (loading !== pending) return;
      loading = null;
      // A late response for A must not prevent B from loading, even if no more
      // DOM mutations occur. A same-account failure is not retried forever.
      if (who !== userId() || epoch !== ownerEpoch) loadIfNeeded();
    });
    loading = pending;
  }
  function sessionChanged() {
    updateOwner();
    sync();
    loadIfNeeded();
  }
  async function toggle(id, button, grade = 'psa10') {
    if (!userId()) { openLoginModal('즐겨찾기를 사용하려면 로그인이 필요합니다'); return; }
    id = String(id);
    if (!/^\d+$/.test(id) || busy) return;
    const who = updateOwner(), epoch = ownerEpoch;
    const current = () => who === userId() && epoch === ownerEpoch;
    const assertCurrent = () => { if (!current()) throw new Error('로그인 변경'); };
    busy = true; sync();
    if (button) button.disabled = true;
    try {
      if (loading) await loading;
      assertCurrent();
      // Read actual row IDs, including favorites saved before this page opened.
      await reload();
      assertCurrent();
      const existing = rows().filter(row => cardId(row) === id);
      if (existing.length) {
        for (const row of existing) {
          assertCurrent();
          await request('/api/portfolio/watchlist/' + encodeURIComponent(row.id), {method:'DELETE'});
          assertCurrent();
          WATCHLIST = rows().filter(item => String(item.id) !== String(row.id));
        }
      } else {
        assertCurrent();
        await request('/api/portfolio/watchlist', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({card_id:id, grade})
        });
        assertCurrent();
        // POST returns {ok,id}, not a watchlist row. Reload also handles upserts.
        await reload();
      }
      assertCurrent();
      window.PortfolioSummaryClient?.invalidate();
      if(typeof scheduleHomeAsset==='function')scheduleHomeAsset();
      showToast(existing.length ? '즐겨찾기 해제' : '즐겨찾기 추가', existing.length ? 'info' : 'success');
      if (typeof renderWatchlist === 'function' && document.getElementById('wlList')) renderWatchlist();
      const count = document.getElementById('pfWatchCount');
      if (count) count.textContent = rows().length;
    } catch {
      if (current()) {
        loaded = false;
        showToast('즐겨찾기를 변경하지 못했습니다. 다시 시도해 주세요.', 'error');
      }
    } finally {
      busy = false; sync();
      if (button) button.disabled = false;
      if (!current()) loadIfNeeded();
    }
  }
  window.CardFavorites = {sync, toggle, sessionChanged};
  document.addEventListener('click', event => {
    const button = event.target.closest(selector);
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    toggle(button.dataset.watchId, button, button.dataset.watchGrade || 'psa10');
  });
  document.addEventListener('DOMContentLoaded', () => {
    sessionChanged();
    const pending = new Set();
    let scheduled = false;
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target?.matches?.(selector)) pending.add(record.target);
        } else {
          for (const node of record.addedNodes || []) {
            if (node.nodeType === 1) buttonsIn(node).forEach(button => pending.add(button));
          }
        }
      }
      if (!pending.size || scheduled) return;
      scheduled = true;
      Promise.resolve().then(() => {
        scheduled = false;
        const buttons = [...pending].filter(button => button.isConnected !== false);
        pending.clear();
        if (!buttons.length) return;
        paintButtons(buttons);
        if (userId() !== owner) sessionChanged();
        else loadIfNeeded();
      });
    }).observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['data-watch-id']});
  });
})();
