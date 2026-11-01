"""Read only visible public search anchors in a standard, unauthenticated browser."""
import re,urllib.parse,urllib.error
class PublicSearchBrowser:
 def __enter__(self):
  from playwright.sync_api import sync_playwright
  self.manager=sync_playwright().start();self.browser=self.manager.chromium.launch(headless=True)
  self.context=self.browser.new_context(locale='ja-JP');self.page=self.context.new_page();self.blocked=None;self.requests=0
  def observe(response):
   host=urllib.parse.urlparse(response.url).hostname or''
   if(host.endswith('mercari.com')or host.endswith('mercari.jp'))and response.status in(401,403,429):self.blocked=(response.url,response.status)
  self.page.on('response',observe);return self
 def links(self,url):
  parsed=urllib.parse.urlparse(url)
  if parsed.scheme!='https'or parsed.hostname!='jp.mercari.com'or parsed.path!='/search':raise ValueError('Only canonical public Mercari searches are allowed')
  if self.blocked:raise urllib.error.HTTPError(self.blocked[0],self.blocked[1],'Original source circuit open',{},None)
  try:self.page.goto(url,wait_until='domcontentloaded',timeout=25000)
  except Exception as e:
   if self.blocked:raise urllib.error.HTTPError(self.blocked[0],self.blocked[1],'Original source circuit open',{},None)
   raise ValueError('Public browser navigation did not complete')from e
  for _ in range(10):
   if self.blocked:raise urllib.error.HTTPError(self.blocked[0],self.blocked[1],'Original source circuit open',{},None)
   links=self.page.locator('a[href]').evaluate_all('(els)=>els.map(e=>e.getAttribute("href")).filter(h=>/^\\/item\\/m[0-9]{11}$/.test(h||""))')
   ids=list(dict.fromkeys(x.rsplit('/',1)[-1]for x in links))
   if ids:return ids[:3]
   self.page.wait_for_timeout(1000)
  return []
 def __exit__(self,*args):
  self.context.close();self.browser.close();self.manager.stop()
