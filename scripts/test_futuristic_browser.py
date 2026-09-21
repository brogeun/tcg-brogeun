"""Browser QA for both Futuristic Box promos and all four product variants."""
import json, threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
options=webdriver.ChromeOptions();options.add_argument('--headless=new');options.add_argument('--remote-debugging-pipe');options.page_load_strategy='eager'
d=webdriver.Chrome(options=options)
d.set_page_load_timeout(30)
d.execute_cdp_cmd('Network.enable',{})
d.execute_cdp_cmd('Network.setBlockedURLs',{'urls':['https://*']})
d.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument',{'source':"if('serviceWorker' in navigator)navigator.serviceWorker.register=()=>Promise.resolve({});"})
wait=WebDriverWait(d,40)
results=[]
try:
 for width in (1280,390):
  d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':width,'height':900,'deviceScaleFactor':1,'mobile':width<640})
  for number,ids in [('131',['897035','881432']),('132',['897036','881433'])]:
   for pid in ids:
    print('CHECK',width,pid,flush=True)
    d.get(f'http://127.0.0.1:{server.server_port}/?set=FURBOX&qa={width}-{pid}#cardinfo')
    wait.until(lambda _:len(d.find_elements(By.CSS_SELECTOR,'.set-card-item[data-anniversary-ids]'))==2)
    item=next(x for x in d.find_elements(By.CSS_SELECTOR,'.set-card-item[data-anniversary-ids]') if pid in x.get_attribute('data-anniversary-ids'))
    item.click()
    wait.until(lambda _:d.find_elements(By.CSS_SELECTOR,f'[data-am-id="{pid}"]'))
    assert len(d.find_elements(By.CSS_SELECTOR,'[data-am-id]'))==2
    d.find_element(By.CSS_SELECTOR,f'[data-am-id="{pid}"]').click()
    wait.until(lambda _:d.find_elements(By.CSS_SELECTOR,'.am-sales tbody tr'))
    text=d.find_element(By.ID,'slideBody').text
    count=len(d.find_elements(By.CSS_SELECTOR,'.am-sales tbody tr'))
    expected=json.loads((ROOT/'data/futuristic-market.json').read_text(encoding='utf-8'))['products'][pid]
    assert count==expected['sales']['totalCount'],(pid,count)
    assert '거래 데이터 없음' not in text
    assert number+'/M-P' in d.find_element(By.ID,'slideName').text
    assert '¥'+format(expected['sales']['trades'][0]['price'],',') in text
    label='개봉' if expected['packaging']=='opened' else '미개봉'
    assert label in d.find_element(By.CSS_SELECTOR,'.slide-price-label').text
    overflow=d.execute_script('return document.documentElement.scrollWidth>innerWidth || document.getElementById("slidePanel").scrollWidth>document.getElementById("slidePanel").clientWidth+1')
    assert not overflow,(pid,width,'overflow')
    results.append({'width':width,'id':pid,'salesRows':count,'overflow':False})
    print('PASS',results[-1],flush=True)
  d.get(f'http://127.0.0.1:{server.server_port}/?set=FURBOX#price/897035')
  wait.until(lambda _:d.find_elements(By.CSS_SELECTOR,'.px-detail .am-sales tbody tr'))
  assert 'A급 · 개봉' in d.find_element(By.ID,'pxLabel').text
  assert d.find_element(By.CSS_SELECTOR,'#pxChart svg').get_attribute('aria-label').startswith('raw')
  assert d.execute_script('return document.documentElement.scrollWidth<=innerWidth')
  print('PASS',width,'expanded detail, grade chart, trade rows',flush=True)
except Exception:
 print('FAILED URL',d.current_url,flush=True)
 print(d.find_element(By.TAG_NAME,'body').text[:2200],flush=True)
 print('BROWSER ERRORS',d.get_log('browser')[-8:],flush=True)
 raise
finally:
 d.quit();server.shutdown()
