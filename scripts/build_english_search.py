"""Build a lazy-loaded search index without duplicating price histories or images."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def build(root=ROOT):
    read = lambda path: json.loads((root/path).read_text('utf-8'))
    catalog = read('data/english-catalog.json')
    names = read('data/english-card-names-ko.json')['names']
    images, image_ids, sets = [], {}, []
    for entry in catalog['sets']:
        cards = read(f"data/english-sets/{entry['code']}.json")['cards']
        rows = []
        for c in cards:
            if c['image'] not in image_ids:
                image_ids[c['image']] = len(images)
                images.append(c['image'])
            s = c['sprite']
            # Row: source ID, original name, Korean name, number, sheet index, column, row.
            rows.append([str(c['sourceId']), c['name'], names.get(c['name'], ''), c['number'], image_ids[c['image']], s['col'], s['row']])
        sets.append({k:entry[k] for k in ('code','name','displayCode','image')} | {'cards':rows})
    payload = dict(schemaVersion=1, images=images, sets=sets)
    target = root/'data/english-search.json'
    target.write_text(json.dumps(payload, ensure_ascii=False, separators=(',',':')), encoding='utf-8')
    print(f"English search: {len(sets)} sets / {sum(len(s['cards']) for s in sets)} cards / {target.stat().st_size} bytes")

if __name__ == '__main__':
    build()
