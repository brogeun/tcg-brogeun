"""Reproduce reviewed static assets in authenticated CI; no credentials are exported."""
from __future__ import annotations
import argparse, concurrent.futures, gzip, hashlib, io, json, re, subprocess, threading, urllib.error, urllib.parse, urllib.request
from pathlib import Path
from build_onepiece_official import build, write
from publish_data_snapshot import official_release_files, publish

def run(root,base=None):
    root=root.resolve();stop=threading.Event();items=[]
    cards=json.loads((root/'config/onepiece-local-artworks.json').read_text(encoding='utf-8'))
    products=json.loads((root/'config/onepiece-product-images.json').read_text(encoding='utf-8'))
    for kind,records in [('card',cards),('product',products)]:
        for key,record in records.items():
            path=root/record['image'].lstrip('/')
            if not path.resolve().is_relative_to(root) or not re.fullmatch(r'images/onepiece-(?:official|products)/[A-Za-z0-9_-]+\.webp',record['image'].lstrip('/')):raise ValueError('Unsafe reviewed asset path')
            if path.is_file():
                if hashlib.sha256(path.read_bytes()).hexdigest()!=record['sha256']:raise ValueError('Existing reviewed image mismatch '+key)
            else:items.append((kind,key,record,path))
    def collect(item):
        from PIL import Image
        kind,key,record,path=item
        if stop.is_set():raise RuntimeError('Source request circuit is open')
        url=record['sourceUrl'];parsed=urllib.parse.urlparse(url)
        if parsed.scheme!='https' or parsed.hostname!='www.onepiece-cardgame.com' or parsed.username or parsed.password:raise ValueError('Only original official image URLs are allowed')
        req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Referer':'https://www.onepiece-cardgame.com/'})
        try:
            with urllib.request.urlopen(req,timeout=30)as response:
                if urllib.parse.urlparse(response.url).hostname!='www.onepiece-cardgame.com':raise ValueError('Unexpected image redirect')
                source=response.read(3_000_001)
                if len(source)>3_000_000:raise ValueError('Oversized source image')
        except urllib.error.HTTPError as error:
            if error.code in (403,429):stop.set()
            raise
        if kind=='card':
            if hashlib.sha256(source).hexdigest()!=record['sourceSHA256']:raise ValueError('Official source changed since artwork review '+key)
            original=Image.open(io.BytesIO(source));original.load()
            alpha=original.mode in ['RGBA','LA']or(original.mode=='P'and'transparency'in original.info)
            image=original.convert('RGBA'if alpha else'RGB')
            if image.width>400:image=image.resize((400,round(image.height*400/image.width)),Image.Resampling.LANCZOS)
            buffer=io.BytesIO();image.save(buffer,format='WEBP',quality=86,method=4);body=buffer.getvalue()
        else:body=source
        if hashlib.sha256(body).hexdigest()!=record['sha256']:raise ValueError('Static image reproduction mismatch '+key)
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body);return key
    if items:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4)as pool:
            for index,_ in enumerate(pool.map(collect,items),1):
                if index%200==0:print(json.dumps({'assetsCompleted':index,'assetsRequired':len(items)}),flush=True)
    source=root/'data/onepiece-official-source.json'
    if not source.exists():
        with gzip.open(root/'config/onepiece-official-snapshot.json.gz','rt',encoding='utf-8')as f:write(source,json.load(f))
    build(root);build(root,validate_only=True)
    subprocess.run(['node','scripts/build_onepiece_search.cjs'],cwd=root,check=True)
    subprocess.run(['node','scripts/build_promo_search.cjs'],cwd=root,check=True)
    subprocess.run(['node','--test','scripts/test_onepiece_official.cjs'],cwd=root,check=True)
    if base:
        files=official_release_files(root,base)
        result=publish(root,base,files,'Materialize reviewed official One Piece inventories and images',official=True)
    else:result={'status':'validated-local','assetsReproduced':len(items)}
    return result
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--base');a=p.parse_args();print(json.dumps(run(a.root,a.base)))
