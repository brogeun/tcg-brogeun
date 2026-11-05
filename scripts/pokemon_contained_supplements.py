"""Apply reviewed Japanese product contents without source requests or price guesses."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

REVIEW_FILE = "data/pokemon-contained-supplements.json"
PRICE_FIELDS = {"minPrice", "lastPrice", "lowestAsk", "grades", "catalogAsk", "currency", "priceCheckedAt"}
def read(path):
    return json.loads(path.read_text(encoding="utf-8"))
def load_review(root):
    path = root / REVIEW_FILE
    if not path.exists():
        return None
    review = read(path)
    if review.get("schemaVersion") != 1 or not review.get("reviewId") or not isinstance(review.get("entries"), list):
        raise ValueError("Invalid reviewed Pokemon contents")
    assets = {r["key"]: r for r in review.get("assets", [])}
    seen = set()
    for entry in review["entries"]:
        card = entry["card"]
        key = entry["setCode"], card["sourceId"]
        if key in seen or entry["action"] not in ("append", "replace"):
            raise ValueError("Duplicate or invalid reviewed card action")
        seen.add(key)
        if card.get("language") != "ja" or card.get("setCode") != entry["setCode"]:
            raise ValueError("Reviewed card changed its language or product")
        if card.get("containedReviewId") != review["reviewId"] or card.get("marketLinkPolicy") != "verified-only":
            raise ValueError("Missing identity or price protection")
        if PRICE_FIELDS.intersection(card):
            raise ValueError("A source quote must not be copied into a contents supplement")
        if card.get("unprintedNumber") and card.get("printedNumber"):
            raise ValueError("An inventory ordinal is not a printed card number")
        asset = assets.get(entry["assetKey"])
        if not asset or card.get("image") != asset["localImage"] or card.get("imageSourceUrl") != asset["imageSourceUrl"]:
            raise ValueError("Card image does not match its reviewed original")
        if card.get("id") and (str(card["id"]) != str(card.get("productId")) or not card.get("marketIdVerification")):
            raise ValueError("Unreviewed marketplace ID")
        if entry["action"] == "replace" and not entry.get("selector"):
            raise ValueError("A correction requires an exact old-source selector")
    return review
def reviewed_identities(root):
    review = load_review(root)
    return {(e["setCode"].upper(), e["card"]["sourceId"]): e["card"] for e in review["entries"]} if review else {}
def is_reviewed_card(card, expected):
    return bool(expected) and all(card.get(k) == v for k, v in expected.items())
def validate_assets(root, review):
    for asset in [*review["assets"], *review.get("covers", [])]:
        name = asset["localImage"]
        if not name.startswith(("/images/pokemon-contained/", "/images/japanese-products/")) or ".." in name.split("/"):
            raise ValueError("Invalid reviewed asset path")
        raw = (root / name.lstrip("/")).read_bytes()
        if len(raw) != asset["bytes"] or hashlib.sha256(raw).hexdigest() != asset["sha256"]:
            raise ValueError("Reviewed original bytes changed: " + name)
def entries_for(review, code):
    return [e for e in review["entries"] if e["setCode"].upper() == code.upper()]
def apply_to_set(source, code, review):
    entries = entries_for(review, code)
    if not entries:
        return copy.deepcopy(source)
    if source.get("code", code).upper() != code.upper() or not isinstance(source.get("cards"), list):
        raise ValueError("Unexpected source product " + code)
    result = copy.deepcopy(source)
    cards = result["cards"]
    for entry in entries:
        expected = copy.deepcopy(entry["card"])
        found = [i for i,c in enumerate(cards) if c.get("sourceId") == expected["sourceId"]]
        if len(found) > 1:
            raise ValueError("Duplicate reviewed identity " + expected["sourceId"])
        if entry["action"] == "replace":
            selector = entry["selector"]
            old = [i for i,c in enumerate(cards) if c.get("sourceId") == selector["sourceId"]]
            if len(old) > 1:
                raise ValueError("Ambiguous old identity")
            if old and not all(cards[old[0]].get(k) == v for k,v in selector.items()):
                raise ValueError("The wrong source changed; re-review before replacing " + code)
            if old:
                if found:
                    cards.pop(old[0])
                    found = [i for i,c in enumerate(cards) if c.get("sourceId") == expected["sourceId"]]
                else:
                    cards[old[0]] = expected
                    found = [old[0]]
            if not found:
                raise ValueError("The reviewed correction source is absent: " + code)
        if found:
            # Canonical supplements never retain a previous card's price or printing.
            cards[found[0]] = expected
        else:
            cards.append(expected)
    identities = [str(c.get("sourceId") or c.get("currentSourceUrl") or c.get("url") or c.get("sourceUrl") or c.get("name")) for c in cards]
    if len(identities) != len(set(identities)):
        raise ValueError("Duplicate source identity after contents repair " + code)
    result["cardCount"] = len(cards)
    result["containedContentsReview"] = {"id":review["reviewId"],"reviewedAt":review["reviewedAt"],
        "appended":sum(e["action"]=="append" for e in entries),"replaced":sum(e["action"]=="replace" for e in entries),
        "referenceUrls":sorted({e["referenceUrl"] for e in entries})}
    return result
def catalogue_card(card, code, existing_id=None):
    price_id = str(card.get("productId") or "") or None
    result = {k:copy.deepcopy(v) for k,v in card.items() if k not in {"id","productId","productIds"}}
    result.update(id=existing_id or "JP:"+code+":review:"+card["sourceId"], setCode=code,boxCode=code,
        originSetCodes=[code],brand="pokemon",kind="card",language="ja",thumbnailUrl=card["image"],
        productId=price_id,productIds=[price_id] if price_id else [],matchStatus="matched" if price_id else "unlinked")
    return result
def patch_catalogue(catalogue, documents, review):
    output = copy.deepcopy(catalogue)
    cards = output["cards"]
    old_count = len(cards)
    for entry in review["entries"]:
        code = entry["setCode"]; expected = entry["card"]
        indices = [i for i,c in enumerate(cards) if (c.get("boxCode") or c.get("setCode")) == code and c.get("sourceId")==expected["sourceId"]]
        if entry["action"]=="replace":
            old = [i for i,c in enumerate(cards) if (c.get("boxCode") or c.get("setCode"))==code and c.get("sourceId")==entry["selector"]["sourceId"]]
            if len(old)>1:raise ValueError("Ambiguous catalogue correction")
            if old:
                i=old[0]
                if cards[i].get("name")!=entry["selector"]["name"] or cards[i].get("image")!=entry["selector"]["image"]:
                    raise ValueError("Catalogue correction source changed")
                if indices:
                    cards.pop(i);indices=[j for j,c in enumerate(cards) if (c.get("boxCode") or c.get("setCode"))==code and c.get("sourceId")==expected["sourceId"]]
                else:
                    cards[i]=catalogue_card(expected,code,cards[i]["id"]);indices=[i]
            if not indices:raise ValueError("Missing catalogue correction source")
        if len(indices)>1:raise ValueError("Duplicate reviewed catalogue row")
        row=catalogue_card(expected,code,cards[indices[0]]["id"] if indices else None)
        if indices:cards[indices[0]]=row
        else:cards.append(row)
    counts=Counter(c.get("boxCode") or c.get("setCode") for c in cards)
    for s in output["sets"]:
        if s["code"] in documents:s["cardCount"]=counts[s["code"]]
        cover=next((a for a in review.get("covers",[]) if a["code"]==s["code"]),None)
        if cover:
            previous=s.get("image") or ""
            allowed={"","images/sets/"+s["code"]+".jpg","/images/sets/"+s["code"]+".jpg",cover["localImage"]}
            if previous not in allowed:raise ValueError("A newer explicit cover must be reviewed before replacement: "+s["code"])
            s["image"]=cover["localImage"];s["imageKind"]=cover["kind"]
    audit=output.setdefault("audit",{})
    audit["sourceRows"]=audit.get("sourceRows",old_count)+len(cards)-old_count
    audit["cardCount"]=len(cards);audit["setCount"]=len(output["sets"])
    audit["linkedCardCount"]=sum(bool(c.get("productId")) for c in cards)
    audit["linkedProductCount"]=len({c["productId"] for c in cards if c.get("productId")})
    audit["matchStatuses"]=dict(Counter(c.get("matchStatus","unlinked") for c in cards))
    for s in audit.get("setCompleteness",[]):
        if s["code"] in documents:
            s.update(sourceRows=documents[s["code"]]["cardCount"],catalogueCount=counts[s["code"]],
                containedReviewId=review["reviewId"])
    audit["containedContentsReview"]={"id":review["reviewId"],"reviewedAt":review["reviewedAt"],"reviewedMemberships":len(review["entries"]),
        "appended":sum(e["action"]=="append" for e in review["entries"]),"replaced":sum(e["action"]=="replace" for e in review["entries"])}
    if len({c["id"] for c in cards})!=len(cards):raise ValueError("Duplicate catalogue IDs")
    for code,doc in documents.items():
        if counts[code]!=doc["cardCount"]:raise ValueError("Source/search card counts disagree: "+code)
    return output
def write_if_changed(path, value):
    if path.exists() and read(path)==value:return False
    temporary=path.with_suffix(path.suffix+".contents-tmp")
    eol = "\r\n" if path.exists() and b"\r\n" in path.read_bytes() else "\n"
    temporary.write_bytes((json.dumps(value,ensure_ascii=False,indent=2)+"\n").replace("\n",eol).encode("utf-8"))
    temporary.replace(path)
    return True
def run(root, validate_only=False):
    review=load_review(root)
    if not review:return {"status":"no-review"}
    validate_assets(root,review)
    codes=sorted({e["setCode"] for e in review["entries"]})
    documents={}
    for code in codes:
        documents[code]=apply_to_set(read(root/"data/cards-by-set"/(code+".json")),code,review)
        if documents[code]["cardCount"]<review["expectedSetCounts"][code]:raise ValueError("Reviewed product lost cards "+code)
    catalogue_path=root/"data/japanese-catalog.json"
    catalogue=patch_catalogue(read(catalogue_path),documents,review)
    changes=[]
    for code,doc in documents.items():
        path=root/"data/cards-by-set"/(code+".json")
        if validate_only:
            if read(path)!=doc:raise ValueError("Contents not materialized: "+code)
        elif write_if_changed(path,doc):changes.append(path.relative_to(root).as_posix())
    if validate_only:
        if read(catalogue_path)!=catalogue:raise ValueError("Search contents not materialized")
    elif write_if_changed(catalogue_path,catalogue):changes.append(catalogue_path.relative_to(root).as_posix())
    return {"status":"validated" if validate_only else "applied","products":len(codes),"reviewedMemberships":len(review["entries"]),
        "changes":changes,"cardCounts":{c:d["cardCount"] for c,d in documents.items()}}
if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument("--validate-only",action="store_true")
    args=parser.parse_args();print(json.dumps(run(args.root,args.validate_only)))
