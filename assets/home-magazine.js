(() => {
  const section = document.querySelector('#home-magazine');
  if (!section) return;
  const grid = section.querySelector('.mag-grid');
  const initial = new Map([...grid.children].map(card=>[card.dataset.code,card]));
  const prototype = grid.firstElementChild;
  async function cardFor(post) {
    if (!/^[\w-]{5,20}$/.test(post.code)) throw Error('Invalid post');
    const card = prototype.cloneNode(true);
    const cover = card.querySelector('.cover');
    const image = card.querySelector('img');
    const source = initial.get(post.code)?.querySelector('img')?.getAttribute('src');
    if (!source && !/^https:\/\/[\w.-]+\.cdninstagram\.com\//.test(post.image)) throw Error('Invalid thumbnail');
    const thumbnail = source || post.image;
    const href = 'https://www.instagram.com/'+(post.video?'reel/':'p/')+post.code+'/';
    const label = post.video ? '릴스' : '게시글';
    const title = post.title || label;
    card.dataset.code = post.code;
    cover.href = href;
    cover.setAttribute('aria-label',title);
    image.referrerPolicy = 'no-referrer';
    image.alt = title;
    image.src = thumbnail;
    if (!source) {
      image.loading = 'eager';
      await image.decode();
    }
    cover.style.setProperty('--pic','url("'+thumbnail.replace(/["\\\n\r]/g,'')+'")');
    card.querySelector('.details > span').textContent = label;
    const instagram = card.querySelector('.insta');
    instagram.href = href;
    instagram.setAttribute('aria-label',instagram.title=title+' · 인스타그램에서 보기');
    const youtube = card.querySelector('.yt');
    if (post.video && /^[\w-]{11}$/.test(post.youtube || '')) {
      youtube.href = 'https://www.youtube.com/shorts/'+post.youtube;
      youtube.setAttribute('aria-label',youtube.title=title+' · 유튜브에서 보기');
    } else youtube.remove();
    return card;
  }
  async function refresh() {
    try {
      const response = await fetch('/api/magazine',{signal:AbortSignal.timeout(16000)});
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.posts) || !data.posts.length) return;
      const cards = await Promise.all(data.posts.slice(0,3).map(cardFor));
      grid.replaceChildren(...cards);
    } catch { /* Keep the verified covers and links already visible. */ }
  }
  if (!('IntersectionObserver' in window)) { refresh(); return; }
  const observer = new IntersectionObserver(entries=>{
    if (entries.some(entry=>entry.isIntersecting)) { observer.disconnect(); refresh(); }
  },{rootMargin:'350px'});
  observer.observe(section);
})();
