from pathlib import Path
import json,time,sys,uuid
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.actions.wheel_input import ScrollOrigin
from selenium.webdriver.common.actions.action_builder import ActionBuilder
from selenium.webdriver.common.actions.pointer_input import PointerInput
import argparse
args=argparse.ArgumentParser(description='Real wheel/touch regressions for all six added card catalogues. Requires Selenium and a dedicated test Chrome instance.')
args.add_argument('--driver',required=True)
args.add_argument('--debugger-address',required=True,help='Dedicated test browser only; never attach to a personal profile')
args.add_argument('--url',default='http://127.0.0.1:4189/')
args.add_argument('--output-dir',type=Path,default=Path('.cache/tcg-card-info-browser'))
a=args.parse_args();CACHE=a.output_dir;CACHE.mkdir(parents=True,exist_ok=True);TAG='verified'
opt=webdriver.ChromeOptions();opt.add_experimental_option('debuggerAddress',a.debugger_address)
d=webdriver.Chrome(service=Service(a.driver,log_output=str(CACHE/'driver.log')),options=opt)
w=WebDriverWait(d,35); report=[]
try:
 d.get(a.url.split('#')[0]+('&' if '?' in a.url else '?')+'qa='+uuid.uuid4().hex[:6]+'#cardinfo');w.until(lambda d:d.execute_script('return !!window.TCGCardInfo'))
 for mobile in [False,True]:
  if mobile:
   d.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
   d.execute_cdp_cmd('Emulation.setTouchEmulationEnabled',{'enabled':True,'maxTouchPoints':1})
  for game in ['nikke','dragon_ball_fusion_world','yugioh','digimon','weiss_schwarz','union_arena']:
   d.execute_script('document.querySelector(arguments[0]).click()',f'#ciTabs [data-ci="{game}"]')
   w.until(lambda d:d.find_elements(By.CSS_SELECTOR,'.tci-set'))
   box=d.execute_async_script('var done=arguments[arguments.length-1];TCGCardInfo.ensureManifest().then(m=>{let g=m.games.find(g=>g.id===arguments[0]);done(g.boxes.find(b=>b.cardCount>30))})',game)
   d.execute_script('TCGCardInfo.open(arguments[0],arguments[1])',game,box['id'])
   w.until(lambda d:len(d.find_elements(By.CSS_SELECTOR,'.tci-card'))>3)
   area=d.find_element(By.CSS_SELECTOR,'.tci-scroll');time.sleep(.2)
   before=d.execute_script('var s=arguments[0],r=s.getBoundingClientRect();return {top:s.scrollTop,h:s.clientHeight,sh:s.scrollHeight,y:r.y,bottom:r.bottom,viewport:innerHeight}',area)
   if mobile:
    rect=area.rect;x=min(350,rect['x']+100);y=min(700,rect['y']+150)
    y=min(720,rect['y']+rect['height']-40);act=ActionChains(d);act.w3c_actions=ActionBuilder(d,mouse=PointerInput('touch','finger'));p=act.w3c_actions.pointer_action;p.move_to_location(x,y);p.pointer_down();p.pause(.15);p.move_to_location(x,y-250);p.release();act.perform()
   else:ActionChains(d).scroll_from_origin(ScrollOrigin.from_element(area,0,0),0,550).perform()
   time.sleep(.35);after=d.execute_script('return arguments[0].scrollTop',area)
   row={'game':game,'mobile':mobile,'box':box['id'],'cards':len(d.find_elements(By.CSS_SELECTOR,'.tci-card')),'before':before,'after':after,'scrollPass':after>before['top'] and before['bottom']<=before['viewport']+1}
   if game=='nikke' and not mobile:d.save_screenshot(str(CACHE/(TAG+'-desktop.png')))
   if game=='digimon' and mobile:d.save_screenshot(str(CACHE/(TAG+'-mobile.png')))
   d.execute_script('document.querySelector(arguments[0]).click()','[data-tci-page="2"]');row['pagePass']=d.execute_script('return TCGCardInfo.state().page===2')
   card=d.find_element(By.CSS_SELECTOR,'[data-tci-card]');d.execute_script('arguments[0].click()',card)
   w.until(lambda d:d.find_elements(By.ID,'tciCardTitle'));row['detailPass']=d.execute_script('return !!TCGCardInfo.state().selected')
   d.execute_script('document.querySelector("[data-tci-back]").click()');w.until(lambda d:d.find_elements(By.ID,'tciCardGrid'))
   d.execute_script('document.querySelector("[data-tci-close]").click()');row['closePass']=d.execute_script('return document.body.style.overflow!=="hidden" && !document.querySelector("#anyModal.open")')
   report.append(row);(CACHE/(TAG+'-browser.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
 print(json.dumps(report,ensure_ascii=True));(CACHE/(TAG+'-browser.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
 assert len(report)==12 and all(all(row[key] for key in ['scrollPass','pagePass','detailPass','closePass']) for row in report), 'Catalogue interaction regression'
finally:d.quit()
