"""Verify registered recommendation artwork and white catalog image frames."""
import argparse,json,time,sys
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
p=argparse.ArgumentParser()
p.add_argument('--driver',required=True)
p.add_argument('--screenshots')
args=p.parse_args()
# Supply the existing public /api/admin?type=etc response on stdin.
# No remote writes or test-generated recommendation content.
items=json.load(sys.stdin)['items']
o=webdriver.ChromeOptions();o.add_argument('--headless=new');o.page_load_strategy='eager'
d=webdriver.Chrome(service=Service(args.driver),options=o)
source="""if('serviceWorker' in navigator)navigator.serviceWorker.register=()=>Promise.resolve({});
const registeredItems=ITEMS;const realFetch=window.fetch;
window.fetch=(url,options)=>{
 const u=new URL(String(url),location.href);
 if(u.pathname==='/api/admin')return Promise.resolve(new Response(JSON.stringify({ok:true,items:u.searchParams.get('type')==='etc'?registeredItems:[]})));
 if(u.pathname==='/api/auth/me')return Promise.resolve(new Response('{"user":null}'));
 return realFetch(url,options);
};""".replace('ITEMS',json.dumps(items))
d.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument',{'source':source})
js=d.execute_script
try:
 for width,height in [(1440,1000),(780,1000),(390,844),(320,740)]:
  d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':width<=768})
  d.get('http://127.0.0.1:8774/index.html#home')
  WebDriverWait(d,20).until(lambda _:len(d.find_elements(By.CSS_SELECTOR,'.home-recommend-grid img'))==5)
  for img in d.find_elements(By.CSS_SELECTOR,'.home-recommend-grid img'):
   js('arguments[0].scrollIntoView({block:"center"})',img)
   WebDriverWait(d,10).until(lambda _:js('return arguments[0].complete && arguments[0].naturalWidth>0',img))
   assert js('return getComputedStyle(arguments[0]).objectFit',img)=='contain'
  js('renderHomeRecommendations();renderHomeRecommendations()')
  assert len(d.find_elements(By.CSS_SELECTOR,'.home-recommend-grid img'))==5
  assert js('return document.documentElement.scrollWidth<=innerWidth')
  if args.screenshots and width in [1440,390]:
   js('document.querySelector(".home-recommend-section").scrollIntoView({block:"center"})')
   d.save_screenshot(str(Path(args.screenshots)/('recommend-restored-'+str(width)+'.png')))
  js('go("cardinfo")')
  for brand in ['onepiece','pokemon']:
   js('CI_TAB=arguments[0];renderCardInfo()',brand)
   assert js('return [...document.querySelectorAll(".ci-redesign .set-tile-img")].every(e=>getComputedStyle(e).backgroundColor==="rgb(255, 255, 255)")')
   assert js('return document.documentElement.scrollWidth<=innerWidth')
   if brand=='onepiece' and args.screenshots and width in [1440,390]:
    js('scrollTo(0,0)')
    time.sleep(.3)
    d.save_screenshot(str(Path(args.screenshots)/('catalog-white-'+str(width)+'.png')))
 # Invalid / absent image cannot become executable markup, icons remain fallback.
 js('renderHomeRecommendations([{link:"https://cafe.naver.com/cardmvk",image:"javascript:alert(1)"}])')
 assert len(d.find_elements(By.CSS_SELECTOR,'.home-recommend-grid img'))==0
 js('renderHomeRecommendations()')
 assert len(d.find_elements(By.CSS_SELECTOR,'.home-recommend-grid img'))==5
 print(json.dumps({'ok':True,'registeredImages':5,'widths':[1440,780,390,320],'bothBrandsWhite':True,'imageFit':'contain','noOverflow':True,'idempotent':True,'safeFallback':True}))
finally:d.quit()
