/* TOP listing quotes and completed-sale changes are deliberately separate. */
(() => {
  const positive = v => v != null && Number.isFinite(Number(v)) && Number(v) > 0;
  const histories = new Map();
  function quote(product) {
    if (window.AnniversaryMarket?.product(product?.id)) return window.AnniversaryMarket.quote(product);
    const value = [product?.lastPrice, product?.lowestAsk].find(positive);
    return value == null ? null : {value:Number(value), currency:product.currency || 'JPY', source:'수집 시점 출품가'};
  }
  async function history(id) {
    const key = String(id);
    if (!histories.has(key)) histories.set(key, (async () => {
      try {
        const response = await fetch(`/data/history/${encodeURIComponent(key)}.json?t=${Math.floor(Date.now()/3600000)}`, {signal:AbortSignal.timeout(10000)});
        if (!response.ok) return null;
        const data = await response.json();
        return Array.isArray(data.history) ? data.history : null;
      } catch { return null; }
    })());
    const result = await histories.get(key);
    if (result == null) histories.delete(key);
    return result;
  }
  function tradeChange(rows, key) {
    const days = new Map();
    for (const row of rows || []) if (/^\d{4}-\d{2}-\d{2}$/.test(row?.date) && positive(row[key])) days.set(row.date, Number(row[key]));
    const sorted = [...days].sort(([a],[b])=>a.localeCompare(b));
    if (sorted.length < 2) return null;
    const [base,end] = sorted.slice(-2);
    return {percent:(end[1]/base[1]-1)*100, from:base[0], to:end[0]};
  }
  window.HomeMarket = {quote, history, tradeChange};
})();
