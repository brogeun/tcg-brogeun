"""Local-only UI checks. Persistence is mocked; no production writes or logins."""
import argparse,json,time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
p=argparse.ArgumentParser();p.add_argument('--driver',required=True);p.add_argument('--artifacts',required=True);p.add_argument('--binary');args=p.parse_args()
o=webdriver.ChromeOptions();o.add_argument('--headless=new');o.add_argument('--remote-debugging-pipe');o.page_load_strategy='eager'
o.add_argument('--disable-gpu');o.add_argument('--disable-software-rasterizer')
if args.binary:o.binary_location=args.binary
d=webdriver.Chrome(service=Service(args.driver),options=o);wait=WebDriverWait(d,35);out=Path(args.artifacts)
d.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument',{'source':"navigator.serviceWorker.register=()=>Promise.resolve({});"})
def viewport(w):d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':w,'height':1000 if w>640 else 844,'deviceScaleFactor':1,'mobile':False})
try:
 viewport(1440);d.get('http://127.0.0.1:8776/index.html#hub')
 wait.until(lambda _:d.execute_script('return !!window.AdminEditorUI && !!window._adminLoaded'))
 wait.until(lambda _:d.execute_script('return AUTH_READY'))
 d.execute_script("const original=window.fetch.bind(window);window.fetch=(url,o={})=>{if(String(url).includes('/api/auth/me'))return Promise.resolve(new Response(JSON.stringify({ok:true,user:CURRENT_USER})));if(String(o.method||'GET').toUpperCase()!=='GET')throw new Error('Production writes blocked by test');return original(url,o);};")
 d.execute_script("document.querySelector('#hubTabs [data-tab=more]').click();document.querySelector('#hubSubTabs [data-subtab=apply]').click()")
 for w in [1920,1440,1180,820,768,640,390,320]:
  viewport(w)
  assert d.execute_script('return document.documentElement.scrollWidth<=innerWidth'),w
  images=d.find_elements(By.CSS_SELECTOR,'.hub-apply-thumb img');assert len(images)==3
  for img in images:
   d.execute_script('arguments[0].scrollIntoView({block:"center"})',img)
   wait.until(lambda _:img.get_property('complete') and img.get_property('naturalWidth')>0)
  for card in d.find_elements(By.CSS_SELECTOR,'.hub-apply-item'):
   cr=card.rect;br=card.find_element(By.CSS_SELECTOR,'.hub-apply-action').rect
   assert br['x']>=cr['x'] and br['x']+br['width']<=cr['x']+cr['width']-10,(w,cr,br)
  d.execute_script('scrollTo(0,0)')
  if w in [1440,390]:d.save_screenshot(str(out/f'raffle-fixed-{w}.png'))
 viewport(1440);d.execute_script("CURRENT_USER={id:'fixture-admin',email:'yhk3213@gmail.com',isAdmin:true};renderAuthStatus();go('admin')")
 wait.until(lambda _:d.find_elements(By.CSS_SELECTOR,'#adminEditor .ql-editor'))
 d.execute_async_script("const done=arguments[0];fetch('/news-detail-example.json').then(r=>r.json()).then(async item=>{item.image='/images/30th.png';window.example=item;EVENTS=[item];ADMIN_TAB='events';renderAdminList();await adminEditEntry(item.id);done();})")
 wait.until(lambda _:'포켓몬 MVC' in d.find_element(By.ID,'adminTitle').get_attribute('value'))
 for w in [1920,1440,1000,768,640,390,320]:
  viewport(w)
  assert d.execute_script('return document.documentElement.scrollWidth<=innerWidth'),w
  assert d.find_element(By.ID,'adminBoard').get_attribute('disabled') is not None
  assert '포켓몬 MVC' in d.find_element(By.ID,'adminCardPreview').text
  d.execute_script('scrollTo(0,0)')
  if w in [1440,390]:d.save_screenshot(str(out/f'admin-editor-after-{w}.png'))
 d.execute_script('AdminEditorUI.preview()')
 assert '구글폼 참조' in d.find_element(By.CSS_SELECTOR,'#hubDetailModal .nd-copy').text
 d.execute_script('HubNewsDetail.close()')
 # Search retains real IDs and disables partial-list reordering.
 d.execute_script("document.getElementById('adminEntrySearch').value='MVC';renderAdminList()")
 assert len(d.find_elements(By.CSS_SELECTOR,'.ae-list .admin-row'))==1
 assert not d.find_element(By.CSS_SELECTOR,'[data-admin-action=up]').is_enabled()
 # Unsaved-change cancel preserves the form.
 d.execute_script("document.getElementById('adminTitle').value='수정 테스트';document.getElementById('adminTitle').dispatchEvent(new Event('input',{bubbles:true}));window.confirm=()=>false;adminClearForm()")
 assert d.find_element(By.ID,'adminTitle').get_attribute('value')=='수정 테스트'
 d.execute_script("go('home')");assert d.execute_script('return document.body.dataset.page')=='admin'
 # Failed save and successful save use only an in-memory test adapter.
 d.execute_script("window.savedPayloads=[];window.saveAdminData=async(type,items)=>{window.savedPayloads.push({type,items});return false;}")
 d.execute_async_script('AdminEditorUI.save().then(arguments[0])')
 assert d.find_element(By.ID,'adminTitle').get_attribute('value')=='수정 테스트'
 assert '게시되지' in d.find_element(By.ID,'adminFormMessage').text
 assert d.execute_script('return window.savedPayloads[0].type')=='events'
 assert d.execute_script('return window.savedPayloads[0].items[0].id')==d.execute_script('return window.example.id')
 d.execute_script('window.saveAdminData=async(type,items)=>{window.savedPayloads.push({type,items});return true;}')
 d.execute_async_script('AdminEditorUI.save().then(arguments[0])')
 assert d.find_element(By.ID,'adminTitle').get_attribute('value')==''
 assert '게시했습니다' in d.find_element(By.ID,'adminFormMessage').text
 # Validation doesn't invoke persistence.
 calls=d.execute_script('return savedPayloads.length')
 d.execute_async_script('AdminEditorUI.save().then(arguments[0])')
 assert '제목' in d.find_element(By.ID,'adminFormMessage').text
 assert d.execute_script('return savedPayloads.length')==calls
 d.execute_script("adminSetMainImage('/images/pokemon-box.webp');adminClearMainImage()")
 assert d.find_element(By.ID,'adminMainImage').get_attribute('value')==''
 assert not d.find_elements(By.CSS_SELECTOR,'#adminMainImagePreview img')
 # UI hints do not grant privileges or change auth state.
 d.execute_script("CURRENT_USER=null;renderAuthStatus();AdminEditorUI.access({email:'yhk3213@gmail.com'})")
 assert not d.execute_script('return document.body.classList.contains("admin-active")')
 assert d.execute_script('return CURRENT_USER') is None
 print(json.dumps({'ok':True,'raffleImages':3,'buttonBounds':True,'responsiveEditor':True,'mockedSaveSuccessAndFailure':True,'unsavedGuard':True,'loggedOutEditorHidden':True}))
finally:d.quit()
