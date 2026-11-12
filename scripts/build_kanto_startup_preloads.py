"""Keep game data deferred while preserving the legacy preload-builder command."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent / 'games/kanto151'
path = root / 'index.html'
html = path.read_text(encoding='utf-8')
lines = ['<!-- kanto-startup-preloads:begin -->',
         '<!-- Game data is requested only after an explicit start action. -->',
         '<!-- kanto-startup-preloads:end -->']
html = re.sub(r'\n?<!-- kanto-startup-preloads:begin -->.*?<!-- kanto-startup-preloads:end -->\n?', '', html, flags=re.S)
html = html.replace('</head>', '\n' + '\n'.join(lines) + '\n</head>')
path.write_text(html, encoding='utf-8')
print('Prepared the light title without eager game JSON requests')
