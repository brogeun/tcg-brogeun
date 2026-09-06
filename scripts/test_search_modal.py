import argparse,json,time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
p=argparse.ArgumentParser()
p.add_argument('--driver',required=True)
p.add_argument('--url',default='http://127.0.0.1:8774/index.html')
p.add_argument('--screenshots')
args=p.parse_args()
assert args.url.startswith(('http://127.0.0.1:','http://localhost:')), 'Local UI regression only'
ROOT=Path(args.screenshots) if args.screenshots else None
o=webdriver.ChromeOptions();o.add_argument('--headless=new');o.page_load_strategy='eager'
d=webdriver.Chrome(service=Service(args.driver),options=o)
d.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument',{'source':"if('serviceWorker' in navigator) navigator.serviceWorker.register=()=>Promise.resolve({});"})
js=d.execute_script
def size(w,h):
 d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':w,'height':h,'deviceScaleFactor':1,'mobile':w<=768})
def waitrows():
 WebDriverWait(d,25).until(lambda _:len(d.find_elements(By.CSS_SELECTOR,'.gs-row'))>0)
def query(q):
 e=d.find_element(By.ID,'gsInput');e.clear();e.send_keys(q,Keys.ENTER);time.sleep(.3)
try:
 size(1440,1000);d.get(args.url)
 WebDriverWait(d,25).until(lambda _:js('return typeof openGlobalSearch === "function"'))
 assert js('return !document.getElementById("searchDialog") || document.getElementById("searchDialog").hidden')
 js('document.getElementById("mobileSearchToggle").click()')
 assert d.find_element(By.ID,'gsInput').get_attribute('value')==''
 js('openGlobalSearch("151")')
 waitrows()
 assert js('return document.querySelector(".gs-panel").getBoundingClientRect().width')==680
 assert js('return document.querySelector(".gs-panel").getBoundingClientRect().height')==600
 assert len(d.find_elements(By.CSS_SELECTOR,'.gs-row'))<=30
 if ROOT:d.save_screenshot(str(ROOT/'search-applied-pc.png'))
 for kind in ['card','box']:
  d.find_element(By.CSS_SELECTOR,'.gs-filter[data-kind="'+kind+'"]').click();time.sleep(.2)
  assert js('return [...document.querySelectorAll(".gs-row")].every(e=>e.dataset.kind===arguments[0])',kind)
 # Exact known box and Korean keyword, no invented names.
 js('openGlobalSearch("743533")');waitrows()
 assert '무니키스 제로' in d.find_element(By.CSS_SELECTOR,'.gs-name').text
 assert d.find_element(By.CSS_SELECTOR,'.gs-row').get_attribute('data-kind')=='box'
 query('무니키스');waitrows()
 assert '무니키스 제로' in d.find_element(By.CSS_SELECTOR,'.gs-name').text
 # Misclassified old box entries must be individual cards here.
 js('openGlobalSearch("887992")');waitrows()
 assert d.find_element(By.CSS_SELECTOR,'.gs-row').get_attribute('data-kind')=='card'
 d.find_element(By.CSS_SELECTOR,'.gs-filter[data-kind="box"]').click();time.sleep(.2)
 assert len(d.find_elements(By.CSS_SELECTOR,'.gs-row'))==0
 js('openGlobalSearch("리자몽")');waitrows()
 assert len(d.find_elements(By.CSS_SELECTOR,'.gs-row'))>0
 query('zzzz-no-matches-987654')
 assert '검색 결과가 없습니다' in d.find_element(By.ID,'gsResults').text
 query('<img src=x onerror=alert(1)>')
 assert len(d.find_elements(By.CSS_SELECTOR,'#gsResults img'))==0
 query('');assert d.find_element(By.ID,'gsResults').text==''
 # Clear while waiting; late result cannot restore stale query.
 js('openGlobalSearch("151");document.getElementById("gsInput").value="";document.getElementById("gsInput").dispatchEvent(new Event("input",{bubbles:true}))')
 time.sleep(.3);assert d.find_element(By.ID,'gsResults').text==''
 # Every navigation section uses same header and does not navigate on open.
 for route in ['home','price','hub','cardinfo','portfolio']:
  js('closeGlobalSearch();location.hash=arguments[0]',route);time.sleep(.2)
  js('document.getElementById("mobileSearchToggle").click()')
  assert not js('return document.getElementById("searchDialog").hidden')
  assert js('return location.hash')=='#'+route
  js('document.getElementById("gsInput").focus()')
  d.switch_to.active_element.send_keys(Keys.SHIFT,Keys.TAB)
  assert js('return document.activeElement.dataset.kind')=='box'
  d.switch_to.active_element.send_keys(Keys.ESCAPE)
  assert js('return document.getElementById("searchDialog").hidden')
 # Real result routing.
 js('openGlobalSearch("743533")');waitrows()
 d.find_element(By.CSS_SELECTOR,'.gs-row').click();time.sleep(.2)
 assert js('return location.hash')=='#price/743533'
 assert js('return document.getElementById("searchDialog").hidden')
 # Narrow and short viewports.
 for w,h in [(320,568),(360,740),(390,844),(430,932),(768,900),(390,450)]:
  size(w,h);js('openGlobalSearch("151")');waitrows();time.sleep(.25)
  dims=js('const p=document.querySelector(".gs-panel"),r=p.getBoundingClientRect();return {top:r.top,w:r.width,h:r.height,over:p.scrollWidth>p.clientWidth,page:document.documentElement.scrollWidth>innerWidth}')
  assert dims=={'top':60,'w':w,'h':h-60,'over':False,'page':False},dims
  assert js('return document.querySelector(".gs-results").scrollHeight>document.querySelector(".gs-results").clientHeight')
  if w==390 and h==844 and ROOT:d.save_screenshot(str(ROOT/'search-applied-mobile.png'))
 # Closing must not reopen the dialog through the hidden legacy input.
 js('closeGlobalSearch();document.getElementById("globalSearch").dispatchEvent(new Event("focus"))')
 assert not js('return document.getElementById("searchDialog").hidden')
 js('closeGlobalSearch()')
 assert js('return document.getElementById("searchDialog").hidden')
 print(json.dumps({'ok':True,'desktop':'680x600','mobileTop':60,'widths':[320,360,390,430,768],'shortHeight':450,'allRoutes':5,'id743533Korean':True,'misclassified887992Corrected':True,'koreanSearch':True,'emptyAndEscaping':True,'staleResults':True,'resultNavigation':True,'noAutoOpen':True}))
finally:d.quit()
