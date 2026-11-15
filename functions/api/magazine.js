const igURL = 'https://www.instagram.com/tcg._.hub/embed/';
const ytURL = 'https://www.youtube.com/@TCGhub-gk/shorts';
const igOwner = 'tcg._.hub';

async function page(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(7000), headers: {'User-Agent':'TCGHUB-Magazine/1.0', 'Accept-Language':'ko-KR,ko;q=0.9'}});
  if (!response.ok) throw Error('Source returned ' + response.status);
  return response.text();
}

export function instagramPosts(html) {
  const field = html.match(/"contextJSON"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (!field) throw Error('Profile embed unavailable');
  const profile = JSON.parse(JSON.parse(field[1])).context;
  if (profile.username !== igOwner) throw Error('Unexpected Instagram profile');
  const posts = new Map();
  for (const row of profile.graphql_media || []) {
    const media = row.shortcode_media;
    if (media?.owner?.username !== igOwner || !/^[\w-]{5,20}$/.test(media.shortcode)) continue;
    const url = new URL(media.display_url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cdninstagram.com')) continue;
    const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    posts.set(media.shortcode, {code:media.shortcode, video:media.is_video === true, title:caption.trim().split(/\r?\n/)[0].slice(0,180), image:url.href, time:media.taken_at_timestamp});
  }
  if (!posts.size) throw Error('Profile contains no supported media');
  return [...posts.values()].sort((a,b)=>b.time-a.time).slice(0,3);
}

function titleKey(title) {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
}

export function youtubeShorts(html) {
  const field = html.match(/(?:var\s+)?ytInitialData\s*=\s*(\{[^]*?\});\s*<\/script>/);
  if (!field) throw Error('Shorts listing unavailable');
  const pending = [JSON.parse(field[1])], titles = new Map();
  while (pending.length) {
    const obj = pending.pop();
    if (!obj || typeof obj !== 'object') continue;
    const item = obj.shortsLockupViewModel;
    if (!item) { pending.push(...Object.values(obj)); continue; }
    const id = (item.entityId || '').replace(/^shorts-shelf-item-/,'');
    const text = item.overlayMetadata?.primaryText?.content || (item.accessibilityText || '').split(/, (?:조회수|[\d,.KMB]+ views)/)[0];
    const key = titleKey(text);
    if (/^[\w-]{11}$/.test(id) && key.length >= 7) {
      titles.set(key, titles.has(key) && titles.get(key) !== id ? null : id);
    }
  }
  return titles;
}

const verified = {Dfr6thVTuch:'N1E5_7-MUAc', Dfmksgpz8Iz:'ps4Y3R9H_lQ'};
const MINUTE = 60000;
export async function onRequestGet({request,waitUntil}) {
  const key = new Request(new URL('/api/magazine',request.url).href);
  const cache = caches.default;
  const cached = await cache.match(key);
  const last = cached && await cached.json();
  const now = Date.now();
  function reply(data, status=200) {
    return Response.json(data,{status,headers:{'Cache-Control':'public, max-age=300'}});
  }
  if (last && now < last.nextCheck) return reply(last,last.posts.length ? 200 : 503);
  let snapshot;
  try {
    const [posts, titles] = await Promise.all([page(igURL).then(instagramPosts),page(ytURL).then(youtubeShorts).catch(()=>null)]);
    for (const post of posts) {
      const previous = last?.posts.find(p=>p.code === post.code);
      post.youtube = post.video && (titles?.get(titleKey(post.title)) || verified[post.code] || previous?.youtube) || null;
    }
    snapshot = {posts,updatedAt:now,nextCheck:now+60*MINUTE};
  } catch {
    snapshot = {posts:last?.posts || [],updatedAt:last?.updatedAt || null,nextCheck:now+5*MINUTE};
  }
  waitUntil(cache.put(key,Response.json(snapshot,{headers:{'Cache-Control':'public, max-age=86400'}})));
  return reply(snapshot,snapshot.posts.length ? 200 : 503);
}
