import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, 'm'));
  assert.ok(match, `Missing shared rule: ${selector}`);
  return match[1];
};
assert.match(rule('.avatar'), /background:\s*#E8FAFA/);
assert.match(rule('.avatar'), /color:\s*#066666/);
assert.match(rule('.avatar'), /border:\s*1px solid #19DFDF/);
assert.match(rule('.mnav'), /repeat\(5, minmax\(0, 1fr\)\)/);
assert.match(rule('.mnav'), /safe-area-inset-bottom/);
assert.match(rule('.mnav-item'), /font-size:\s*14px/);
assert.match(rule('.mnav-item'), /min-height:\s*56px/);
assert.match(rule('.mnav-item.active'), /background:\s*#E8FAFA/);
assert.match(rule('.mnav-item .ic svg'), /width:\s*20px; height:\s*20px/);
assert.doesNotMatch(html, /body\.home-signed-in:has\(\.home-v3\.active\)\s+(?:\.mnav|#topAvatar)/);
const nav = html.match(/<nav class="mnav">([\s\S]+?)<\/nav>/)[1];
assert.deepEqual([...nav.matchAll(/data-nav="([^"]+)"/g)].map(m => m[1]), ['home','price','hub','cardinfo','portfolio']);
assert.match(nav, /카드 정보/);
assert.doesNotMatch(nav, /mo-home-only|mo-home-original/);
let scripts = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=|application\/ld\+json/i.test(match[1]) || !match[2].trim()) continue;
  new vm.Script(match[2]);
  scripts++;
}
console.log(JSON.stringify({ok:true,sharedAvatar:true,sharedNavigation:true,routes:5,inlineScripts:scripts}));
