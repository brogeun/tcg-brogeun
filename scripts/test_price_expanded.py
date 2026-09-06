"""Read-only browser QA for expanded detail and its before/after preview."""
import argparse,json,time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
p=argparse.ArgumentParser();p.add_argument('--driver',required=True);p.add_argument('--screenshots',required=True);args=p.parse_args()
options=webdriver.ChromeOptions();options.add_argument('--headless=new');options.page_load_strategy='eager'
options.add_argument('--remote-debugging-pipe')
d=webdriver.Chrome(service=Service(args.driver),options=options)
d.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument',{'source':"if('serviceWorker' in navigator)navigator.serviceWorker.register=()=>Promise.resolve({});"})
out=Path(args.screenshots);results=[]
def ready():
 WebDriverWait(d,40).until(lambda _:d.find_elements(By.CSS_SELECTOR,'#pxCurrent'))
def viewport(width):
 d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':width,'height':1100 if width>640 else 844,'deviceScaleFactor':1,'mobile':width<=640})
def mobile_symmetry():
 metrics=d.execute_script('''const p=document.getElementById('slidePanel'),pr=p.getBoundingClientRect();
 return {gutter:p.offsetWidth-p.clientWidth,rootGutter:innerWidth-document.documentElement.clientWidth,
 items:['#slideCardImg','#slideName','#slideBody .slide-price-box'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {selector:s,left:r.left-pr.left,right:pr.right-r.right};})};''')
 assert metrics['gutter']==0 and metrics['rootGutter']==0,metrics
 for item in metrics['items']:
  assert abs(item['left']-item['right'])<1 and abs(item['left']-16)<1,metrics
 return metrics
try:
 for width in [1920,1440,1000,768,640,390,360,320]:
  viewport(width);d.get('http://127.0.0.1:8776/index.html#price/722239');ready()
  WebDriverWait(d,10).until(lambda _:d.find_element(By.CSS_SELECTOR,'.px-art img').get_property('complete'))
  assert d.execute_script('return document.documentElement.scrollWidth<=innerWidth'),width
  assert not d.find_element(By.CSS_SELECTOR,'.topbar').is_displayed()
  assert not d.find_element(By.CSS_SELECTOR,'.sidebar').is_displayed()
  assert not d.find_element(By.CSS_SELECTOR,'.mnav').is_displayed()
  assert len(d.find_elements(By.CSS_SELECTOR,'[data-px-grade]'))==6
  assert d.find_element(By.CSS_SELECTOR,'.px-detail').get_attribute('data-product-kind')=='card'
  assert '메가리자몽' in d.find_element(By.CSS_SELECTOR,'.px-title').text
  assert 'M2a' in d.find_element(By.CSS_SELECTOR,'.px-info').text
  assert '2025.11.28' in d.find_element(By.CSS_SELECTOR,'.px-info').text
  assert d.find_element(By.CSS_SELECTOR,'.px-art').rect['width']>=200
  assert d.find_element(By.CSS_SELECTOR,'.px-art').rect['height']>=260
  d.find_element(By.CSS_SELECTOR,'[data-px-grade="raw"]').click()
  assert 'A급' in d.find_element(By.ID,'pxLabel').text
  assert d.find_element(By.ID,'pxCurrent').text==d.find_element(By.CSS_SELECTOR,'[data-px-grade="raw"] .px-grade-price').text
  d.execute_script('document.getElementById("pxRange").value="30";document.getElementById("pxRange").dispatchEvent(new Event("change"))')
  assert d.find_element(By.CSS_SELECTOR,'#pxChart svg').get_attribute('aria-label').startswith('raw')
  d.find_element(By.CSS_SELECTOR,'[data-px-grade="psa10"]').click()
  d.execute_script('scrollTo(0,0)')
  if width in [1440,390]:d.save_screenshot(str(out/f'price-expanded-after-{width}.png'))
  results.append({'width':width,'overflow':False,'gradeChartSync':True})
 # First-click panel: large artwork, one scroll area, sticky close and no overflow.
 for width in [1440,1000,820,720,390,360,320]:
  viewport(width);d.get('http://127.0.0.1:8776/index.html#price')
  WebDriverWait(d,30).until(lambda _:d.execute_script('return typeof openSlidePanel==="function"'))
  d.execute_script("openSlidePanel('722239')")
  WebDriverWait(d,30).until(lambda _:d.find_element(By.ID,'slideName').text not in ['', '—'])
  time.sleep(.4)
  panel=d.find_element(By.ID,'slidePanel');art=d.find_element(By.ID,'slideCardImg')
  assert abs(panel.rect['width']-(680 if width>720 else width))<2,(width,panel.rect)
  assert art.rect['height']>=(320 if width>720 else 288),(width,art.rect)
  assert art.rect['width']>=width-54 if width<=720 else art.rect['width']>600,(width,art.rect)
  assert d.execute_script('return document.getElementById("slidePanel").scrollWidth<=document.getElementById("slidePanel").clientWidth'),width
  assert d.execute_script('return document.documentElement.scrollWidth<=innerWidth'),width
  assert d.find_element(By.ID,'slideName').rect['y']>=art.rect['y']+art.rect['height']
  assert d.execute_script('return getComputedStyle(document.documentElement).overflowY')=='hidden'
  if width<=720:mobile_symmetry()
  if width in [1440,390]:d.save_screenshot(str(out/f'price-slide-after-{width}.png'))
  d.execute_script('document.getElementById("slidePanel").scrollTop=10000')
  assert d.find_element(By.CSS_SELECTOR,'#slidePanel .slide-header').rect['y']<5
  d.find_element(By.CSS_SELECTOR,'#slidePanel [aria-label="닫기"]').click()
  WebDriverWait(d,3).until(lambda _:not panel.is_displayed())
  assert d.execute_script('return getComputedStyle(document.documentElement).overflowY')!='hidden'
 # Missing grades remain empty, with working portfolio/login gates.
 viewport(320);d.get('http://127.0.0.1:8776/index.html#price/722239');ready()
 d.find_element(By.CSS_SELECTOR,'[data-px-grade="bgs95"]').click()
 assert not d.find_element(By.ID,'pxPortfolio').is_enabled()
 d.find_element(By.CSS_SELECTOR,'[data-px-grade="raw"]').click()
 d.find_element(By.ID,'pxPortfolio').click()
 WebDriverWait(d,5).until(lambda _:d.execute_script('return document.getElementById("anyModal").classList.contains("home-login-modal") && document.getElementById("anyModal").classList.contains("open")'))
 d.execute_script('closeAnyModal()')
 # Direct matching for the regression box, not grading it as a card.
 d.get('http://127.0.0.1:8776/index.html#price/743533');ready()
 assert d.find_element(By.CSS_SELECTOR,'.px-detail').get_attribute('data-product-kind')=='box'
 assert len(d.find_elements(By.CSS_SELECTOR,'[data-px-grade]'))==1
 assert '무니키스 제로' in d.find_element(By.CSS_SELECTOR,'.px-title').text
 assert 'M3' in d.find_element(By.CSS_SELECTOR,'.px-info').text
 assert '2026.01.23' in d.find_element(By.CSS_SELECTOR,'.px-info').text
 for id,code,date in [('846048','M6','2026.07.31'),('806644','M5','2026.05.22'),('846050','M6','2026.07.31'),('299926','OP09','2024.08.31')]:
  d.get('http://127.0.0.1:8776/index.html#price/'+id);ready()
  info=d.find_element(By.CSS_SELECTOR,'.px-info').text
  assert code in info and date in info,(id,info)
  d.execute_script("go('home');openSlidePanel(arguments[0])",id)
  WebDriverWait(d,30).until(lambda _:date in d.find_element(By.ID,'slideBody').text and code in d.find_element(By.ID,'slidePack').text)
  assert code in d.find_element(By.ID,'slidePack').text
  d.execute_script('closeSlidePanel()')
 # Expansion round-trip from actual slide panel restores origin and same product.
 d.execute_script("go('home');openSlidePanel('887992')")
 WebDriverWait(d,30).until(lambda _:d.find_element(By.ID,'slideName').text not in ['', '—'] and d.execute_script('return CURRENT_SLIDE_ID')=='887992')
 time.sleep(.4) # The slide button must finish its opening transition before pointer clicks.
 d.find_element(By.ID,'slideFullBtn').click();ready()
 assert d.find_element(By.CSS_SELECTOR,'.px-detail').get_attribute('data-product-kind')=='card',(d.current_url,d.find_element(By.CSS_SELECTOR,'.px-title').text)
 assert '미등록' in d.find_element(By.CSS_SELECTOR,'.px-info').text
 d.find_element(By.CSS_SELECTOR,'[data-px-back]').click()
 WebDriverWait(d,10).until(lambda _:d.find_element(By.ID,'slidePanel').get_attribute('aria-hidden')=='false')
 assert d.execute_script('return CURRENT_SLIDE_ID')=='887992'
 assert d.current_url.endswith('#home')
 assert not d.execute_script('return document.body.classList.contains("price-expanded")')
 # Unit assertions: explicit currencies; seven calendar days; no made-up grade price.
 assert d.execute_script("return PriceExpandedTest.quote({lowest_ask:100,currency:'JPY'}).currency")=='JPY'
 assert d.execute_script("return PriceExpandedTest.quote({lowest_ask:0})") is None
 assert d.execute_script("return PriceExpandedTest.change7([{date:'2026-09-01',psa10_price:100},{date:'2026-09-08',psa10_price:110}],'psa10_price')")>9.9
 assert d.execute_script("return PriceExpandedTest.change7([{date:'2026-08-01',psa10_price:100},{date:'2026-09-08',psa10_price:110}],'psa10_price')") is None
 # Before and after really load in the requested comparison window.
 viewport(1440);d.get('http://127.0.0.1:8776/price-expand-compare.html')
 for key in ['before','after']:
  d.switch_to.frame(d.find_element(By.ID,key))
  WebDriverWait(d,40).until(lambda _:d.find_element(By.ID,'priceDetailPanel').is_displayed())
  if key=='after':ready()
  d.switch_to.default_content()
 time.sleep(2);d.save_screenshot(str(out/'price-expanded-compare-pc.png'))
 d.find_element(By.CSS_SELECTOR,'[data-mode="mobile"]').click();time.sleep(1)
 d.save_screenshot(str(out/'price-expanded-compare-mobile.png'))
 viewport(1440);d.get('http://127.0.0.1:8776/price-slide-compare.html')
 for key in ['before','after']:
  d.switch_to.frame(d.find_element(By.ID,key))
  WebDriverWait(d,40).until(lambda _:d.find_element(By.ID,'slideName').text not in ['', '—'])
  d.switch_to.default_content()
 time.sleep(1);d.save_screenshot(str(out/'price-slide-compare-pc.png'))
 d.find_element(By.CSS_SELECTOR,'[data-mode="mobile"]').click();time.sleep(1)
 d.switch_to.frame(d.find_element(By.ID,'after'))
 symmetry=mobile_symmetry()
 d.execute_script('document.getElementById("slidePanel").scrollTop=500')
 assert d.execute_script('return document.getElementById("slidePanel").scrollTop')>0
 d.execute_script('document.getElementById("slidePanel").scrollTop=0')
 d.switch_to.default_content()
 d.save_screenshot(str(out/'price-slide-compare-mobile.png'))
 print(json.dumps({'ok':True,'viewports':results,'slideViewports':[1440,1000,820,720,390,360,320],'box743533':True,'onepieceCard':True,'backToPanel':True,'loginGate':True,'comparison':True}))
finally:d.quit()
