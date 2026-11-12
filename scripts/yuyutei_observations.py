"""Publish dated original Yuyutei observations without fetching denied pages on CI."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone, timedelta
import gzip
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

import collect_yuyutei_market as market

FIELDS = ("sourceProductId", "cardNumber", "rarity", "name", "price", "stock",
          "stockState", "purchasable", "stockText", "image")
FORMAT = "yuyutei-original-set-observations-v1"


def timestamp(value):
    if not isinstance(value,str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",value):
        raise ValueError("Original observation requires a UTC timestamp")
    parsed=datetime.fromisoformat(value.replace("Z","+00:00"))
    if parsed>datetime.now(timezone.utc)+timedelta(minutes=5):
        raise ValueError("Future observation")
    return parsed


def export(data, since):
    timestamp(since)
    batches=[]
    for game,(source_game,_) in market.GAMES.items():
        for path in sorted((data/"yuyutei-market"/game).glob("*.json")):
            d=market.read_json(path,{})
            stamp=d.get("lastSuccessAt","")
            if stamp<since or d.get("collectionScope")!="set_listing":continue
            code=d["sourceSetCode"]
            if (d.get("source")!="yuyutei" or d.get("game")!=game or path.stem!=code or
                    d.get("sourceUrl")!=market.safe_set_url(source_game,code)):raise ValueError(str(path))
            cards=[]
            for record in d["records"]:
                if record.get("sourceAsOf")!=stamp or record.get("notObservedInLatestSnapshot"):continue
                expected=f"https://yuyu-tei.jp/sell/{source_game}/card/{code}/{record['sourceProductId']}"
                if (record.get("sourceUrl")!=expected or record.get("currency")!="JPY" or
                        record.get("grade")!="raw" or record.get("priceKind")!="asking"):raise ValueError(expected)
                cards.append([record.get(k) for k in FIELDS])
            if cards:batches.append({"game":game,"set":code,"name":d.get("name") or code,"url":d["sourceUrl"],"observedAt":stamp,"cards":cards})
    return batches


def unpack(batch):
    game,code,stamp=batch["game"],batch["set"],batch["observedAt"]
    timestamp(stamp)
    source=market.GAMES[game][0]
    if not market.SET_RE.fullmatch(code) or batch["url"]!=market.safe_set_url(source,code):raise ValueError("Invalid source set")
    cards=[];seen=set()
    for values in batch["cards"]:
        if not isinstance(values,list) or len(values)!=len(FIELDS):raise ValueError("Invalid original row")
        r=dict(zip(FIELDS,values));pid=r["sourceProductId"]
        if not isinstance(pid,str) or not re.fullmatch(r"[0-9]+",pid) or pid in seen:raise ValueError("Invalid or duplicate product ID")
        seen.add(pid)
        if not all(isinstance(r[k],str) for k in ("cardNumber","name","rarity","stockState")) or not r["cardNumber"] or not r["name"]:
            raise ValueError("Missing printed identity")
        if r["price"] is not None and (type(r["price"]) is not int or r["price"]<=0):raise ValueError("Invalid JPY ask")
        if r["stock"] is not None and (type(r["stock"]) is not int or r["stock"]<0):raise ValueError("Invalid stock")
        if r["purchasable"] is not None and type(r["purchasable"]) is not bool:raise ValueError("Invalid availability")
        if r["image"]:
            image=urlsplit(r["image"])
            if image.scheme!="https" or image.netloc!="card.yuyu-tei.jp":raise ValueError("Unexpected image host")
        r.update(id=f"yuyutei:{source}:{code}:{pid}",game=game,source="yuyutei",language="ja",grade="raw",
                 setCode=market.canonical_set(game,code,r["cardNumber"]),sourceSetCode=code,
                 sourceUrl=f"https://yuyu-tei.jp/sell/{source}/card/{code}/{pid}",currency="JPY",priceKind="asking",
                 variant=(r["rarity"]+" "+r["name"]).strip(),sourceAsOf=stamp,fetchedAt=stamp)
        cards.append(r)
    if not cards:raise ValueError("Empty set observation")
    return cards


def load_file(path):
    with gzip.open(path,"rb") as handle:payload=handle.read(32_000_001)
    if len(payload)>32_000_000:raise ValueError("Observation file exceeds size limit")
    obj=json.loads(payload)
    if obj.get("format")!=FORMAT or tuple(obj.get("fields",()))!=FIELDS:raise ValueError("Unrecognized observation format")
    return [(b,unpack(b)) for b in obj["sets"]]


def save_file(path,batches):
    for b in batches:unpack(b)
    if not batches:raise ValueError("No new original observations")
    value={"format":FORMAT,"fields":FIELDS,"sets":sorted(batches,key=lambda b:(b["game"],b["set"],b["observedAt"]))}
    raw=json.dumps(value,ensure_ascii=False,separators=(",",":")).encode("utf8")
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(".tmp")
    temporary.write_bytes(gzip.compress(raw,mtime=0));temporary.replace(path)


def apply(data, path):
    grouped=defaultdict(list)
    for batch,cards in load_file(path):grouped[batch["game"]].append((batch,cards))
    manifest_path=data/"yuyutei-market.json"
    manifest=market.read_json(manifest_path,{})
    summaries={v["game"]:v for v in manifest["games"]}
    counts={}
    latest_applied=""
    for game,batches in grouped.items():
        source,_=market.GAMES[game]
        index_path=data/"yuyutei-market"/(game+".json")
        index=market.read_json(index_path,{})
        columns=index["columns"];idcol=columns.index("sourceProductId");timecol=columns.index("sourceAsOf")
        by_set=defaultdict(dict)
        for row in index["rows"]:by_set[row[0]][row[idcol]]=row
        sets={v["sourceSetCode"]:v for v in index["sets"]}
        fresh=added=0
        for batch,cards in sorted(batches,key=lambda item:item[0]["observedAt"]):
            code,stamp=batch["set"],batch["observedAt"]
            indexed=by_set[code]
            detail_path=data/"yuyutei-market"/game/(code+".json")
            detail=market.read_json(detail_path,{})
            old={v["id"]:v for v in detail.get("records",[])}
            newer=[]
            for record in cards:
                pid=record["sourceProductId"]
                observed=max(old.get(record["id"],{}).get("sourceAsOf") or "",(indexed[pid][timecol] or "") if pid in indexed else "")
                if stamp<=observed:continue
                added+=int(pid not in indexed)
                newer.append(record)
            if not newer:continue
            latest_applied=max(latest_applied,stamp)
            fresh+=len(newer)
            merged=market.merge_records(list(old.values()),newer)
            as_of=max(r["sourceAsOf"] for r in merged)
            detail={**detail,"schemaVersion":1,"source":"yuyutei","game":game,"language":"ja","sourceGame":source,
                    "sourceSetCode":code,"name":batch["name"],"sourceUrl":batch["url"],"sourceAsOf":as_of,"generatedAt":market.utc_now(),
                    "lastSuccessAt":detail.get("lastSuccessAt") or as_of,"collectionScope":detail.get("collectionScope","product_observations"),
                    "priceKind":"asking","currency":"JPY","records":merged}
            market.atomic_json(detail_path,detail)
            for record in newer:indexed[record["sourceProductId"]]=market.index_row(record,columns)
            sets[code]={**sets.get(code,{}),"sourceSetCode":code,"name":batch["name"],"url":batch["url"],
                        "recordCount":len(indexed),"shard":f"/data/yuyutei-market/{game}/{code}.json",
                        "collectionScope":detail["collectionScope"],"sourceAsOf":as_of,"lastSuccessAt":detail["lastSuccessAt"]}
        if not fresh:continue
        rows=[row for code in sets for row in by_set[code].values()]
        as_of=max(row[timecol] or "" for row in rows)
        index.update(generatedAt=market.utc_now(),sourceAsOf=as_of,sets=list(sets.values()),rows=rows)
        market.atomic_json(index_path,index)
        summary=summaries[game]
        summary.update(recordCount=len(rows),pricedCount=sum(row[columns.index("price")] is not None for row in rows),sourceAsOf=as_of)
        counts[game]={"observationsApplied":fresh,"newProducts":added}
    if counts:
        manifest.update(generatedAt=market.utc_now(),sourceAsOf=max(r.get("sourceAsOf") or "" for r in summaries.values()),
                        games=[summaries[g] for g in market.GAMES if g in summaries])
        manifest["lastImport"]={"outcome":"imported","source":"original_yuyutei_set_listings","sourceAsOf":latest_applied,
                                "importedAt":market.utc_now(),"observationsApplied":sum(x["observationsApplied"] for x in counts.values()),
                                "newProducts":sum(x["newProducts"] for x in counts.values()),"games":counts}
        market.atomic_json(manifest_path,manifest)
    return counts


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=["export","import","fresh"])
    parser.add_argument("--data",type=Path,default=market.REPO/"data")
    parser.add_argument("--file",type=Path,default=market.REPO/"automation-sources/yuyutei/latest.json.gz")
    parser.add_argument("--since")
    args=parser.parse_args()
    if args.action=="export":
        if not args.since:parser.error("--since is required for export")
        batches=export(args.data,args.since);save_file(args.file,batches)
        print(json.dumps({"sets":len(batches),"observations":sum(len(b["cards"]) for b in batches)}))
    elif args.action=="fresh":
        batches=load_file(args.file)
        latest=max(timestamp(b["observedAt"]) for b,_ in batches)
        age=datetime.now(timezone.utc)-latest
        print(json.dumps({"sourceAsOf":latest.isoformat(),"ageHours":round(age.total_seconds()/3600,2)}))
        sys.exit(0 if age<=timedelta(hours=26) else 1)
    else:
        print(json.dumps(apply(args.data,args.file)))
