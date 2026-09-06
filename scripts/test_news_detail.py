"""Read-only local browser QA for news detail and real-data comparison."""
import argparse,json,time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
p=argparse.ArgumentParser();p.add_argument('--driver',required=True);p.add_argument('--artifacts',required=True);args=p.parse_args()
options=webdriver.ChromeOptions();options.add_argument('--headless=new');options.add_argument('--remote-debugging-pipe');options.page_load_strategy='eager'
d=webdriver.Chrome(service=Service(args.driver),options=options);wait=WebDriverWait(d,35);out=Path(args.artifacts)
d.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument',{'source':"if('serviceWorker' in navigator)navigator.serviceWorker.register=()=>Promise.resolve({});"})
def viewport(width):d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':width,'height':900 if width>640 else 844,'deviceScaleFactor':1,'mobile':False})
def loaded():wait.until(lambda _:d.execute_script('return !!window.HubNewsDetail && !!window._adminLoaded'))
def opened():wait.until(lambda _:d.find_element(By.ID,'hubDetailModal').get_attribute('open') is not None)
try:
 viewport(1440);d.get('http://127.0.0.1:8776/index.html#hub');loaded()
 d.execute_async_script("const done=arguments[0];fetch('/news-detail-example.json').then(r=>r.json()).then(x=>{window.testNewsItem=x;done();})")
 for width in [1920,1440,768,640,480,390,360,320]:
  viewport(width)
  d.execute_script("HubNewsDetail.open(window.testNewsItem)");opened()
  m=d.find_element(By.ID,'hubDetailModal');body=d.find_element(By.CSS_SELECTOR,'#hubDetailModal .nd-body')
  r=m.rect
  assert abs(r['width']-(600 if width>640 else width-32))<1,(width,r)
  assert abs(r['x']-(width-r['width'])/2)<1,(width,r)
  assert r['height']<=(900*.8+1 if width>640 else 844-32+1),(width,r)
  assert d.execute_script('return document.documentElement.scrollWidth<=innerWidth')
  assert d.execute_script('return arguments[0].scrollWidth<=arguments[0].clientWidth',body)
  assert '구글폼 참조' in body.text and '안녕하세요' in body.text
  assert len(body.find_elements(By.TAG_NAME,'p'))>=10
  assert body.value_of_css_property('font-size')=='16px'
  assert body.value_of_css_property('line-height')=='24px'
  assert body.find_element(By.TAG_NAME,'a').get_attribute('target')=='_blank'
  assert 'noopener' in body.find_element(By.TAG_NAME,'a').get_attribute('rel')
  if width<=640:
   metrics=d.execute_script('const b=arguments[0],c=b.querySelector(".nd-copy"),r=b.getBoundingClientRect(),s=c.getBoundingClientRect();return [s.left-r.left,r.right-s.right,b.offsetWidth-b.clientWidth]',body)
   assert metrics==[16,16,0],metrics
  if width in [1440,390]:d.save_screenshot(str(out/f'news-detail-after-{width}.png'))
  for _ in range(7):ActionChains(d).send_keys(Keys.TAB).perform();assert d.execute_script('return document.getElementById("hubDetailModal").contains(document.activeElement)')
  d.execute_script('arguments[0].scrollTop=10000',body)
  assert d.find_element(By.CSS_SELECTOR,'[data-nd-close]').is_displayed()
  ActionChains(d).send_keys(Keys.ESCAPE).perform()
  assert not m.is_displayed()
  assert not d.execute_script('return document.documentElement.classList.contains("hub-detail-open")')
 # Long text, special characters, sanitized rich HTML, safe media and URLs.
 d.execute_script("HubNewsDetail.open({title:'긴 제목 '.repeat(8),content:'첫 단락 &amp; 테스트\\n\\n'+('긴 본문 '.repeat(500))+'마지막 문장',link:'https://example.com/?a=1&b=2'})")
 assert '마지막 문장' in d.find_element(By.CSS_SELECTOR,'.nd-copy').get_attribute('textContent')
 assert '첫 단락 & 테스트\n\n' in d.find_element(By.CSS_SELECTOR,'.nd-copy').get_attribute('textContent')
 d.execute_script('''HubNewsDetail.open({title:'보안 검증',content:'<script>window.unsafe=true<\/script><p onclick="window.unsafe=true" style="width:9000px">안전 <a href="javascript:alert(1)">링크</a></p><iframe src="/index.html"></iframe><img src="/images/market/onepiece-logo.png" onerror="window.unsafe=true"><p>마지막</p>'})''')
 assert not d.execute_script('return !!window.unsafe')
 assert not d.find_elements(By.CSS_SELECTOR,'#hubDetailModal .nd-copy script,#hubDetailModal .nd-copy iframe,#hubDetailModal .nd-copy [onclick],#hubDetailModal .nd-copy [style]')
 assert not d.find_element(By.CSS_SELECTOR,'.nd-copy a').get_attribute('href')
 assert d.find_element(By.CSS_SELECTOR,'.nd-copy img').get_attribute('src').endswith('/images/market/onepiece-logo.png')
 # Mock the browser share capability: no actual external sharing.
 d.execute_script('Object.defineProperty(navigator,"share",{configurable:true,value:async x=>{window.sharedNews=x}})')
 d.find_element(By.CSS_SELECTOR,'[data-nd-share]').click()
 wait.until(lambda _:d.execute_script('return !!window.sharedNews'))
 d.execute_script('Object.defineProperty(navigator,"share",{configurable:true,value:undefined});Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async x=>{window.copiedNews=x}}})')
 d.find_element(By.CSS_SELECTOR,'[data-nd-share]').click();wait.until(lambda _:'복사했습니다' in d.find_element(By.CSS_SELECTOR,'.nd-status').text)
 d.execute_script('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{throw new Error("Denied")}}})')
 d.find_element(By.CSS_SELECTOR,'[data-nd-share]').click();wait.until(lambda _:d.find_element(By.CSS_SELECTOR,'.nd-share-fallback input').is_displayed())
 ActionChains(d).move_by_offset(2,2).click().perform()
 # Reliable backdrop coordinates with native dialog.
 d.execute_script('HubNewsDetail.open(window.testNewsItem)')
 d.execute_cdp_cmd('Input.dispatchMouseEvent',{'type':'mousePressed','x':2,'y':2,'button':'left','clickCount':1})
 d.execute_cdp_cmd('Input.dispatchMouseEvent',{'type':'mouseReleased','x':2,'y':2,'button':'left','clickCount':1})
 wait.until(lambda _:not d.find_element(By.ID,'hubDetailModal').is_displayed())
 # Real event card trigger + focus restoration. Official links stay direct.
 d.execute_script("document.querySelector('#hubTabs [data-tab=more]').click();document.querySelector('#hubSubTabs [data-subtab=events]').click();document.getElementById('eventListHub').innerHTML=_hubRowCard(window.testNewsItem,{},'event')")
 trigger=d.find_element(By.CSS_SELECTOR,'#eventListHub [data-news-detail]');trigger.click();opened()
 d.find_element(By.CSS_SELECTOR,'[data-nd-close]').click();assert d.execute_script('return document.activeElement===arguments[0]',trigger)
 assert d.execute_script("return HubNewsDetail.isDirectNews({link:'https://pokemoncard.co.kr/_news?id=21033',content:'<p><br></p>'})")
 assert d.execute_script("return HubNewsDetail.isDirectNews({link:'https://www.onepiece-cardgame.kr/topics/view.do?brdno=1',content:'내용'})")
 assert not d.execute_script("return HubNewsDetail.isDirectNews({link:'https://forms.gle/example',content:'자체 이벤트 내용'})")
 assert not d.execute_script("return HubNewsDetail.isDirectNews({link:'javascript:alert(1)'})")
 d.execute_script('showOripaUsage(0)');opened();assert '단계별 사용법' in d.find_element(By.CSS_SELECTOR,'.nd-copy').text
 d.execute_script("go('home')");assert not d.find_element(By.ID,'hubDetailModal').is_displayed()
 # Shared login dialog remains separate.
 d.execute_script('openAnyModal("<p>기존 공용 모달</p>")');assert d.find_element(By.ID,'anyModal').is_displayed();d.execute_script('closeAnyModal()')
 # PC + mobile before/after rendering using the real event fixture.
 viewport(1440);d.get('http://127.0.0.1:8776/news-detail-compare.html')
 for side in ['before','after']:
  d.switch_to.frame(d.find_element(By.ID,side))
  if side=='after':opened()
  else:wait.until(lambda _:d.find_element(By.CSS_SELECTOR,'#eventListHub .hubcard-body').is_displayed())
  d.switch_to.default_content()
 d.save_screenshot(str(out/'news-detail-compare-pc.png'))
 d.find_element(By.CSS_SELECTOR,'[data-mode="mobile"]').click();time.sleep(.3)
 d.save_screenshot(str(out/'news-detail-compare-mobile.png'))
 print(json.dumps({'ok':True,'widths':[1920,1440,768,640,480,390,360,320],'realEvent':True,'officialDirectLinks':True,'richTextSafety':True,'shareFallbacks':True,'keyboardFocus':True,'comparison':True}))
finally:d.quit()
