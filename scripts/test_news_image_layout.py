"""News image layout regression against the local site's real news feed."""
import argparse,json,time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
p=argparse.ArgumentParser()
p.add_argument('--driver',required=True)
p.add_argument('--screenshots')
args=p.parse_args()
o=webdriver.ChromeOptions();o.add_argument('--headless=new');o.page_load_strategy='eager'
d=webdriver.Chrome(service=Service(args.driver),options=o)
d.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument',{'source':"if('serviceWorker' in navigator)navigator.serviceWorker.register=()=>Promise.resolve({});"})
results=[]
try:
 for width in [1920,1440,1000,780,640,390,320]:
  d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':width,'height':1000,'deviceScaleFactor':1,'mobile':width<=640})
  d.get('http://127.0.0.1:8774/index.html#hub')
  WebDriverWait(d,20).until(lambda _:len(d.find_elements(By.CSS_SELECTOR,'#newsList .hub-news-card'))==15)
  # Load the first six real images; preserve URL and source data.
  d.execute_script('document.querySelectorAll("#newsList .hub-news-image").forEach((i,n)=>{if(n<6)i.loading="eager"})')
  WebDriverWait(d,25).until(lambda _:d.execute_script('return [...document.querySelectorAll("#newsList .hub-news-image")].slice(0,6).every(i=>i.complete)'))
  time.sleep(.2)
  measurements=d.execute_script('''return [...document.querySelectorAll("#newsList .hub-news-image")].filter(i=>i.naturalWidth).map(i=>{
   const s=getComputedStyle(i),p=i.parentElement;return {fit:s.objectFit,position:s.position,poster:i.classList.contains("hub-news-poster"),
    nw:i.naturalWidth,nh:i.naturalHeight,w:i.clientWidth,h:i.clientHeight,pw:p.clientWidth,ph:p.clientHeight};
  })''')
  assert len(measurements)>=3
  for m in measurements:
   assert m['fit']=='contain' and m['position']=='absolute',m
   assert abs(m['w']-m['pw'])<=1,m
   assert m['poster']==(m['nh']>m['nw']*1.8),m
   if m['poster']:
    assert abs(m['w']/m['h']-m['nw']/m['nh'])<.01,m
   else:
    assert abs(m['h']-m['ph'])<=1,m
  assert d.execute_script('return document.documentElement.scrollWidth<=innerWidth')
  if width>640:
   assert d.execute_script('return [...document.querySelectorAll("#newsList .hub-news-card")].every(c=>Math.abs(c.getBoundingClientRect().height-280)<1)')
  else:
   assert d.execute_script('return [...document.querySelectorAll("#newsList .hub-news-placeholder")].every(c=>Math.abs(c.clientWidth/c.getBoundingClientRect().height-16/9)<.02)')
  if args.screenshots and width in [1440,1000,390]:
   d.save_screenshot(str(Path(args.screenshots)/('news-fixed-'+str(width)+'.png')))
  first=d.find_element(By.CSS_SELECTOR,'#newsList .hub-news-card').get_attribute('href')
  assert first.startswith('https://')
  d.execute_script('arguments[0].click()',d.find_element(By.CSS_SELECTOR,'#newsPageButtons [aria-label="다음 페이지"]'))
  assert len(d.find_elements(By.CSS_SELECTOR,'#newsList .hub-news-card'))==15
  assert d.find_element(By.CSS_SELECTOR,'#newsList .hub-news-card').get_attribute('href')!=first
  d.execute_script('arguments[0].click()',d.find_element(By.CSS_SELECTOR,'#newsPageButtons [aria-label="이전 페이지"]'))
  assert d.find_element(By.CSS_SELECTOR,'#newsList .hub-news-card').get_attribute('href')==first
  results.append({'width':width,'loadedImages':len(measurements),'contain':True,'pagination':True,'overflow':False})
 # Real empty-image One Piece notice receives its brand logo, not a newspaper.
 notice=d.find_element(By.CSS_SELECTOR,'a[href*="brdno=6456"]')
 logo=notice.find_element(By.CSS_SELECTOR,'.hub-news-brand-logo')
 d.execute_script('arguments[0].scrollIntoView({block:"center"})',logo)
 WebDriverWait(d,10).until(lambda _:d.execute_script('return arguments[0].naturalWidth>0',logo))
 assert logo.get_attribute('src').endswith('/images/market/onepiece-logo.png')
 # Empty Pokemon images and failed article images use the same safe fallback.
 for width in [1440,390]:
  d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':width,'height':1000,'deviceScaleFactor':1,'mobile':width<500})
  d.execute_script('''HUB_NEWS_ITEMS=[{title:'포켓몬 이미지 없음 검사',source:'pokemon',image:''},{title:'원피스 이미지 없음 검사',source:'onepiece',image:''}];HUB_NEWS_PAGE=1;renderHubNewsPage();scrollTo(0,0)''')
  for brand_image in d.find_elements(By.CSS_SELECTOR,'.hub-news-brand-logo'):
   d.execute_script('arguments[0].loading="eager"',brand_image)
   WebDriverWait(d,15).until(lambda _:d.execute_script('return arguments[0].naturalWidth>0',brand_image))
   assert brand_image.is_displayed()
   assert d.execute_script('return getComputedStyle(arguments[0]).objectFit',brand_image)=='contain'
  assert d.execute_script('return document.documentElement.scrollWidth<=innerWidth')
  if args.screenshots:d.save_screenshot(str(Path(args.screenshots)/('news-brand-fallback-'+str(width)+'.png')))
 d.execute_script('''HUB_NEWS_ITEMS=[{title:'이미지 오류 검사',source:'onepiece',image:'/images/market/onepiece-logo.png'}];renderHubNewsPage();document.querySelector('.hub-news-image').dispatchEvent(new Event('error'))''')
 assert d.find_element(By.CSS_SELECTOR,'.hub-news-brand-logo').is_displayed()
 d.execute_script('document.querySelector(".hub-news-brand-logo").dispatchEvent(new Event("error"))')
 assert 'ONE PIECE CARD GAME' in d.find_element(By.CSS_SELECTOR,'.hub-news-fallback').text
 print(json.dumps({'ok':True,'viewports':results,'mobileLayoutPreserved':True,'brandFallbacks':True,'failedImageFallback':True}))
finally:d.quit()
