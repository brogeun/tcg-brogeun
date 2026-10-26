import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const googleStart=html.indexOf('let _nativeSocialLoginPending =');
const google=html.slice(googleStart,html.indexOf('// SocialLogin 통합 초기화',googleStart));
const initStart=html.indexOf('let _socialLoginInitialized =');
const init=html.slice(initStart,html.indexOf('// ---- Apple Sign In ----',initStart));
const appleStart=html.indexOf('async function startAppleLogin(');
const apple=html.slice(appleStart,html.indexOf('// 카카오 로그인 시작',appleStart));
const code=google+init+apple;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(setImmediate);
function harness({initialize=async()=>{},login=async()=>({result:{idToken:'mock-token',profile:{}}}),api=async()=>({ok:true,json:async()=>({ok:true})}),platform='ios',native=true,agreements=true,social=true,legacy}={}){
 const calls={initialize:0,login:[],requests:[],toasts:[],configs:[]};
 const bridge={initialize:async config=>{calls.initialize++;calls.configs.push(config);return initialize();},login:async options=>{calls.login.push(options.provider);return login(options);}};
 const ctx=vm.createContext({window:{location:{href:''},Capacitor:{isNativePlatform:()=>native,getPlatform:()=>platform,Plugins:{...(social?{SocialLogin:bridge}:{}),...(legacy?{GoogleAuth:legacy}:{})}}},
  _verifyAgreements:()=>agreements,crypto:{randomUUID:()=> 'mock-nonce'},console:{warn(){},error(){}},showToast:t=>calls.toasts.push(t),fetch:async(url,options)=>{calls.requests.push({url,body:JSON.parse(options.body),credentials:options.credentials});return api();}});
 vm.runInContext(code,ctx);return {ctx,calls};
}
test('failed native initialization stops both Google and Apple before SDK login or server POST',async()=>{
 for(const name of ['startGoogleLogin','startAppleLogin']){const h=harness({initialize:async()=>{throw Error('mock init failure');}});await h.ctx[name]();assert.equal(h.calls.initialize,1);assert.equal(h.calls.login.length,0);assert.equal(h.calls.requests.length,0);assert.equal(h.calls.toasts.length,1);}
});
test('concurrent Google taps and Google/Apple taps open one native provider flow',async()=>{
 for(const second of ['startGoogleLogin','startAppleLogin']){const pending=deferred(),h=harness({initialize:()=>pending.promise});const attempts=[h.ctx.startGoogleLogin(),h.ctx[second]()];await flush();assert.equal(h.calls.initialize,1);assert.equal(h.calls.login.length,0);pending.resolve();await Promise.all(attempts);assert.deepEqual(h.calls.login,['google']);assert.equal(h.calls.requests.length,1);assert.equal(h.ctx.window.location.href,'/?login=success');}
});
test('the shared initialization promise deduplicates direct callers',async()=>{
 const pending=deferred(),h=harness({initialize:()=>pending.promise});const attempts=[h.ctx._initSocialLogin(),h.ctx._initSocialLogin()];assert.equal(h.calls.initialize,1);pending.resolve();await Promise.all(attempts);await h.ctx._initSocialLogin();assert.equal(h.calls.initialize,1);
});
test('failed initialization permits a clean explicit retry',async()=>{
 let tries=0;const h=harness({initialize:async()=>{if(++tries===1)throw Error('first init fails');}});await h.ctx.startGoogleLogin();await h.ctx.startGoogleLogin();assert.equal(h.calls.initialize,2);assert.deepEqual(h.calls.login,['google']);assert.equal(h.calls.requests.length,1);
});
test('provider cancellation releases the shared login guard for a later attempt',async()=>{
 let tries=0;const h=harness({login:async()=>{if(++tries===1)throw Error('user cancelled');return {result:{idToken:'mock-token'}};}});await h.ctx.startGoogleLogin();await h.ctx.startAppleLogin();assert.equal(h.calls.initialize,1);assert.deepEqual(h.calls.login,['google','apple']);assert.equal(h.calls.requests.length,1);assert.equal(h.calls.requests[0].url,'/api/auth/apple/native');
});
test('a rejected server response and a network error release the native login guard',async()=>{
 for(const failure of ['response','network']){let tries=0;const h=harness({api:async()=>{if(++tries===1){if(failure==='network')throw Error('offline');return {ok:false,json:async()=>({ok:false,error:'mock rejected'})};}return {ok:true,json:async()=>({ok:true})};}});await h.ctx.startGoogleLogin();await h.ctx.startGoogleLogin();assert.equal(h.calls.requests.length,2);assert.equal(h.ctx.window.location.href,'/?login=success');}
});
test('missing native plugin and denied agreements do not call provider or API',async()=>{
 for(const options of [{social:false},{agreements:false}]){const h=harness(options);await h.ctx.startGoogleLogin();await h.ctx.startAppleLogin();assert.equal(h.calls.initialize,0);assert.equal(h.calls.login.length,0);assert.equal(h.calls.requests.length,0);}
});
test('web Google redirect and Android Apple rejection retain their existing contracts',async()=>{
 const web=harness({native:false});await web.ctx.startGoogleLogin();assert.equal(web.ctx.window.location.href,'/api/auth/google/start');assert.equal(web.calls.initialize,0);
 const android=harness({platform:'android'});await android.ctx.startAppleLogin();assert.equal(android.calls.initialize,0);assert.equal(android.calls.requests.length,0);assert.equal(android.calls.toasts.length,1);
});
test('legacy GoogleAuth fallback remains supported without the SocialLogin bridge',async()=>{
 let initialized=0,signed=0;const h=harness({social:false,legacy:{initialize:async()=>{initialized++;},signIn:async()=>{signed++;return {authentication:{idToken:'legacy-mock-token'}};}}});await h.ctx.startGoogleLogin();assert.equal(initialized,1);assert.equal(signed,1);assert.equal(h.calls.requests[0].body.idToken,'legacy-mock-token');assert.equal(h.calls.requests[0].credentials,'include');
});
test('initialization preserves platform client configuration',async()=>{
 for(const platform of ['ios','android']){const h=harness({platform});await h.ctx.startGoogleLogin();const config=h.calls.configs[0];assert.equal(config.google.webClientId,'163173913025-2smamjb11famoenksmsoqf0b52q9qges.apps.googleusercontent.com');assert.equal(config.google.iOSClientId,'163173913025-ndu8nof28n3h8bemldpskr197h1luo7h.apps.googleusercontent.com');assert.equal(!!config.apple,platform==='ios');}
});
