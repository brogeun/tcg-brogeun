/* Private home valuation is kept only in the current account's memory. */
(() => {
  'use strict';
  let generation=0,owner=null,pending=null,cached=null;
  const validNumber=value=>typeof value==='number'&&Number.isFinite(value);
  function invalidate(){generation++;owner=null;pending=null;cached=null;}
  function valid(data,expected){
    return data?.ok===true&&String(data.userId)===expected&&
      ['holdingsCount','watchCount'].every(key=>Number.isSafeInteger(data[key])&&data[key]>=0)&&
      ['totalValueJpy','totalCostJpy'].every(key=>validNumber(data[key])&&data[key]>=0)&&
      typeof data.sourceHash==='string'&&/^[a-f0-9]{64}$/.test(data.sourceHash)&&
      /^\d{4}-\d{2}-\d{2}$/.test(data.fx?.asOf||'')&&validNumber(data.fx?.rates?.JPY)&&data.fx.rates.JPY>0;
  }
  async function get(ownerId,{timeoutMs=4000}={}){
    const expected=String(ownerId||'');
    if(!expected)throw Error('A current account is required');
    if(owner!==expected){invalidate();owner=expected;}
    if(cached&&cached.expires>Date.now())return cached.value;
    if(pending)return pending;
    const started=generation,controller=new AbortController();
    let timer,work;
    const current=()=>started===generation&&owner===expected;
    const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Home summary timed out'));},timeoutMs);});
    const request=(async()=>{
      const response=await fetch('/api/portfolio/summary',{credentials:'include',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
      if(!response.ok)throw Error('Home summary HTTP '+response.status);
      const data=await response.json();
      if(!valid(data,expected)||!current()||controller.signal.aborted)throw Error('Home summary identity or snapshot changed');
      cached={value:data,expires:Date.now()+30000};return data;
    })();
    work=Promise.race([request,deadline]).finally(()=>{clearTimeout(timer);controller.abort();if(pending===work)pending=null;});
    pending=work;return work;
  }
  window.PortfolioSummaryClient={get,invalidate};
})();
