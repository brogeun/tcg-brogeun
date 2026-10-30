"""Preload critical JSON without speculatively linking the import-map module graph."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent / 'games/kanto151'
data = ['species','moves','biomes','type-chart','pokemon-manifest','game-design','locale-entities','locale-messages','locale-literals','species-localized','regions-localized','region-compositions','moves-localized']
lines = ['<!-- kanto-startup-preloads:begin -->']
lines += [f'<link rel="preload" as="fetch" href="./data/{name}.json" crossorigin>' for name in data]
lines += ['<!-- kanto-startup-preloads:end -->']
path = root / 'index.html'
html = path.read_text(encoding='utf-8')
html = re.sub(r'\n?<!-- kanto-startup-preloads:begin -->.*?<!-- kanto-startup-preloads:end -->\n?', '', html, flags=re.S)
html = html.replace('</head>', '\n' + '\n'.join(lines) + '\n</head>')
path.write_text(html, encoding='utf-8')
print(f'Prepared {len(data)} critical JSON preloads; module imports follow the import map normally')
