"""Local login UI regression. Requires selenium; never sends login requests.

python scripts/test_login_screen.py --driver PATH [--screenshots DIRECTORY]
"""
import argparse
import json
import time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

p = argparse.ArgumentParser()
p.add_argument('--driver', required=True)
p.add_argument('--url', default='http://127.0.0.1:8774/index.html')
p.add_argument('--screenshots')
args = p.parse_args()
assert args.url.startswith(('http://127.0.0.1:', 'http://localhost:')), 'Local test only'
options = webdriver.ChromeOptions()
options.add_argument('--headless=new')
options.page_load_strategy = 'eager'
d = webdriver.Chrome(service=Service(args.driver), options=options)
js = d.execute_script
def el(id):
    return d.find_element(By.ID, id)
def open_login():
    js('openLoginModal()')
    time.sleep(.25)
def agree():
    el('agreeAll').click()
def disabled():
    return all(not el(id).is_enabled() for id in ['loginKakaoBtn', 'loginGoogleBtn', 'loginAppleBtn', 'loginEmailInput', 'loginSubmit'])
try:
    d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride', {'width':1440,'height':1000,'deviceScaleFactor':1,'mobile':False})
    d.get(args.url)
    WebDriverWait(d, 20).until(lambda _: js('return typeof openLoginModal === "function"'))
    # Stub only authentication requests; site data continue loading normally.
    js('''window.loginRequests=[];const originalFetch=window.fetch;
      window.fetch=(url,options)=>{
        if(String(url).startsWith('/api/auth/') && String(url)!=='/api/auth/me') {
          loginRequests.push({url,options});
          return new Promise((resolve,reject)=>{window.resolveLogin=resolve;window.rejectLogin=reject});
        }
        return originalFetch(url,options);
      };''')
    open_login()
    assert disabled()
    assert js('return document.querySelector(".modal-box").getBoundingClientRect().width') == 420
    assert js('return getComputedStyle(document.getElementById("loginKakaoBtn")).fontSize') == '16px'
    assert len(d.find_elements(By.CSS_SELECTOR, '.agreeItem')) == 3
    # Focus wraps even while email and social controls are disabled.
    d.switch_to.active_element.send_keys(Keys.SHIFT, Keys.TAB)
    assert js('return document.activeElement.id') == 'agreeAge'
    d.switch_to.active_element.send_keys(Keys.TAB)
    assert 'login-close' in js('return document.activeElement.className')
    agree()
    assert el('loginGoogleBtn').is_enabled() and el('loginEmailInput').is_enabled()
    el('agreeAge').click()
    assert disabled() and js('return document.getElementById("agreeAll").indeterminate')
    el('agreeAge').click()
    assert el('agreeAll').is_selected()
    el('loginEmailInput').send_keys('invalid')
    el('loginSubmit').click()
    assert el('loginEmailInput').get_attribute('aria-invalid') == 'true'
    assert js('return loginRequests.length') == 0
    el('loginEmailInput').clear()
    el('loginEmailInput').send_keys('Test@Example.com', Keys.ENTER)
    js('submitLogin();submitLogin()')
    assert js('return loginRequests.length') == 1 and disabled()
    assert json.loads(js('return loginRequests[0].options.body')) == {'email':'test@example.com'}
    el('agreeAge').click()
    js('resolveLogin({ok:false,json:async()=>({error:"테스트 실패"})})')
    WebDriverWait(d, 5).until(lambda _: '테스트 실패' in el('loginMsg').text)
    assert disabled()
    el('agreeAge').click()
    el('loginSubmit').click()
    js('rejectLogin(new Error("offline"))')
    WebDriverWait(d, 5).until(lambda _: '네트워크 오류' in el('loginMsg').text)
    assert el('loginSubmit').is_enabled()
    el('loginSubmit').click()
    js('resolveLogin({ok:true,json:async()=>({ok:true})})')
    WebDriverWait(d, 5).until(lambda _: '발송 완료' in el('loginSubmit').text)
    js('submitLogin()')
    assert js('return loginRequests.length') == 3
    assert not el('loginEmailInput').is_enabled()
    assert el('loginGoogleBtn').is_enabled()
    # A late request must never update a newly opened dialog.
    open_login(); agree()
    el('loginEmailInput').send_keys('test@example.com')
    el('loginSubmit').click()
    open_login()
    js('resolveLogin({ok:true,json:async()=>({ok:true})})')
    time.sleep(.1)
    assert disabled() and el('loginMsg').text == ''
    # Existing provider button dispatch (no external OAuth navigation).
    js('window.providers=[];startKakaoLogin=()=>providers.push("kakao");startGoogleLogin=()=>providers.push("google");startAppleLogin=()=>providers.push("apple")')
    agree()
    for id in ['loginKakaoBtn', 'loginGoogleBtn', 'loginAppleBtn']:
        el(id).click()
    assert js('return providers') == ['kakao','google','apple']
    if args.screenshots:
        d.save_screenshot(str(Path(args.screenshots) / 'login-applied-pc.png'))
    # Close/backdrop and opener restoration; shared modal styling stays intact.
    js('closeAnyModal();window.openerTest=document.querySelector("button");openerTest.focus();openLoginModal()')
    d.switch_to.active_element.send_keys(Keys.ESCAPE)
    assert js('return document.activeElement===openerTest && !document.getElementById("anyModal").classList.contains("open")')
    open_login()
    js('document.getElementById("anyModal").click()')
    assert js('return !document.getElementById("anyModal").classList.contains("open")')
    js('openAnyModal("<p>shared modal</p>","wide")')
    assert js('return !document.getElementById("anyModal").classList.contains("home-login-modal")')
    # Real responsive viewport checks, including short keyboard-like height.
    for width,height in [(320,568),(360,740),(390,844),(430,932),(768,900),(390,450)]:
        d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':True})
        open_login()
        bounds = js('const b=document.querySelector(".modal-box");return {width:b.clientWidth,height:b.getBoundingClientRect().height,overflow:b.scrollWidth>b.clientWidth,page:document.documentElement.scrollWidth>innerWidth}')
        assert bounds == {'width':width,'height':height,'overflow':False,'page':False}, bounds
        agree()
        el('loginEmailInput').send_keys('test@example.com')
        el('loginSubmit').click()
        js('resolveLogin({ok:false,json:async()=>({error:"다시 시도해주세요"})})')
        WebDriverWait(d, 5).until(lambda _: el('loginSubmit').is_enabled())
        if width == 390 and height == 844 and args.screenshots:
            js('document.querySelector(".modal-box").scrollTop=0')
            d.save_screenshot(str(Path(args.screenshots) / 'login-applied-mobile.png'))
    print(json.dumps({'ok':True,'desktop':420,'mobileWidths':[320,360,390,430,768],'shortViewport':450,'consentGating':True,'duplicateRequestGuard':True,'lateResponseIsolation':True,'errorsAndSuccess':True,'providerDispatch':True,'focusAndClose':True,'realAuthRequests':0}))
finally:
    d.quit()
