import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const newsData = JSON.parse(readFileSync(join(root, 'data/news.json'), 'utf8'));

const hubStart = html.indexOf('<section class="page hub-redesign" data-page="hub">');
const hubEnd = html.indexOf('<!-- 카드 정보 -->', hubStart);
assert(hubStart >= 0 && hubEnd > hubStart, 'redesigned news section not found');
const hub = html.slice(hubStart, hubEnd);

assert.match(hub, /<h1>소식<\/h1>/, 'news page title missing');
assert.match(hub, /뉴스 · 이벤트 · 오리파 · 매장 · 커뮤니티/, 'news subtitle missing');
assert.deepEqual(
  [...hub.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]),
  ['news', 'shops', 'more'],
  'primary news tabs changed',
);
assert.deepEqual(
  [...hub.matchAll(/data-news-subtab="([^"]+)"/g)].map(match => match[1]),
  ['news', 'cardshow'],
  'news secondary tabs changed',
);
assert.deepEqual(
  [...hub.matchAll(/data-subtab="([^"]+)"/g)].map(match => match[1]),
  ['events', 'apply', 'oripa', 'grading', 'etc'],
  'other secondary tabs changed',
);

assert.match(hub, /\.news-grid \{[^}]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\); gap:20px;/, 'five-column news grid missing');
assert.match(hub, /\.hub-news-card \{[^}]*height:280px;/, '280px news card missing');
assert.match(hub, /\.hub-news-placeholder \{[^}]*height:180px;/, '180px placeholder missing');
assert.match(hub, /\.hub-news-image \{[^}]*object-fit:cover;/, 'official news image cover style missing');
assert.match(hub, /\.hub-news-fallback\[hidden\] \{ display:none; \}/, 'broken-image fallback state missing');
assert.match(hub, /\.hub-apply-grid \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\); gap:20px;/, 'two-column raffle grid missing');
assert.match(hub, /\.hub-apply-item \{[^}]*height:145px;/, '145px raffle row missing');
assert.match(hub, /\.hub-apply-thumb \{[^}]*width:145px; height:145px; background:#EDECE8;/, 'raffle placeholder dimensions missing');
assert.match(hub, /\.hub-apply-action \{[^}]*width:101px; height:40px;/, 'raffle action dimensions missing');
assert.match(hub, /@media \(max-width:420px\) \{\s*\.news-grid \{ grid-template-columns:1fr; \}/, 'single-column phone news grid missing');
assert.match(hub, /#hubSubTabs \{ gap:4px; \}/, 'phone other-tab overflow guard missing');
assert.match(hub, /#hubSubTabs \.tab \{ padding-left:8px; padding-right:8px; \}/, 'phone other-tab compact padding missing');
assert.match(html, /fetch\(`\/data\/news\.json\?t=/, 'local static news fallback missing');
assert.match(html, /Promise\.allSettled\(\[/, 'automatic and manual news merge missing');
assert.match(html, /autoItems\.forEach/, 'automatic news items are not merged');
assert.match(html, /adminItems\.forEach/, 'manual news items are not merged');
assert.match(html, /href="\$\{escapeHtml\(n\.link\)\}" target="_blank" rel="noopener"/, 'official source direct link missing');
assert.match(html, /class="hub-news-image" src="\$\{escapeHtml\(imageUrl\)\}"/, 'official main image rendering missing');
assert.match(html, /onerror="this\.hidden=true;this\.nextElementSibling\.hidden=false"/, 'image load fallback missing');
assert.match(html, /const HUB_NEWS_PANELS = \['news', 'cardshow'\]/, 'news/card-show state group missing');
assert.match(html, /const HUB_MORE_PANELS = \['events', 'apply', 'oripa', 'grading', 'etc'\]/, 'other state group missing');
assert.match(html, /let HUB_SUB = 'apply'/, 'raffle must be the default other tab');
assert.match(html, /class="hub-news-placeholder"/, 'news placeholder markup missing');
assert.match(html, /class="hub-apply-thumb"/, 'raffle placeholder markup missing');
assert(newsData.ok && Array.isArray(newsData.items) && newsData.items.length > 0, 'news fallback JSON is invalid or empty');

console.log(JSON.stringify({
  ok: true,
  fallbackNewsItems: newsData.items.length,
  primaryTabs: ['news', 'shops', 'more'],
  newsTabs: ['news', 'cardshow'],
  otherTabs: ['events', 'apply', 'oripa', 'grading', 'etc'],
}, null, 2));
