import {withAuth,jsonResponse} from '../../_shared/auth.js';
import {loadHoldingQuotes,valueHoldings} from '../../_shared/portfolio-summary.js';

// GET only: no caller-supplied owner/card list and no changes to portfolio data.
export function createPortfolioSummary({deadlineMs=10000}={}){
  const privateJSON=(value,status=200)=>jsonResponse(value,status,{'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'});
  const authenticated=withAuth(async({request,env,user,summarySignal})=>{
    if(summarySignal.aborted)throw Error('Portfolio summary deadline exceeded');
    const [holdingRows,watchCount]=await Promise.all([
      env.DB.prepare('SELECT card_id, grade, qty, buy_price FROM holdings WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM watchlists WHERE user_id = ?').bind(user.id).first(),
    ]);
    const holdings=holdingRows.results||[];
    if(holdings.length>10000||!Number.isSafeInteger(watchCount?.count)||watchCount.count<0)throw Error('Invalid portfolio summary input');
    const {manifest,quotes}=await loadHoldingQuotes({assets:env.ASSETS,origin:request.url,holdings,signal:summarySignal});
    const totals=valueHoldings(holdings,quotes,manifest.fx.rates);
    if(![totals.totalValueJpy,totals.totalCostJpy,totals.totalValueKrw,totals.differenceKrw].every(Number.isFinite))throw Error('Invalid portfolio summary totals');
    return privateJSON({ok:true,userId:String(user.id),holdingsCount:holdings.length,watchCount:watchCount.count,...totals,
      sourceHash:manifest.sourceHash,asOf:manifest.fx.asOf,fx:manifest.fx});
  });
  return async context=>{
  const controller=new AbortController();let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Portfolio summary deadline exceeded'));},deadlineMs);});
  try{
    const response=await Promise.race([authenticated({...context,summarySignal:controller.signal}),deadline]);
    response.headers.set('Cache-Control','private, no-store');response.headers.set('Vary','Cookie');
    return response;
  }catch{
    // The client retains its existing valuation path when the generated quote
    // snapshot is unavailable, incomplete, mixed-version, or timed out.
    return privateJSON({ok:false,error:'summary_unavailable'},503);
  }finally{clearTimeout(timer);controller.abort();}
  };
}
export const onRequestGet=createPortfolioSummary();
