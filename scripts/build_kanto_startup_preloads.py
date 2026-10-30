"""Preload the existing static module graph and critical JSON, without bundling it."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent / 'games/kanto151'
seen = set()

def visit(path):
    path = path.resolve()
    if path in seen:
        return
    seen.add(path)
    source = path.read_text(encoding='utf-8')
    for specifier in re.findall(r'(?:import|export)\s+[^;]*?from\s*[\'\"]([^\'\"]+)[\'\"]', source):
        if specifier.startswith('.'):
            visit(path.parent / specifier)

visit(root / 'src/main.mjs')
modules = sorted('./' + path.relative_to(root.resolve()).as_posix() for path in seen)
data = ['species','moves','biomes','type-chart','pokemon-manifest','game-design','locale-entities','locale-messages','locale-literals','species-localized','regions-localized','region-compositions','moves-localized']
lines = ['<!-- kanto-startup-preloads:begin -->']
lines += [f'<link rel="modulepreload" href="{path}">' for path in modules]
lines += [f'<link rel="preload" as="fetch" href="./data/{name}.json" crossorigin>' for name in data]
lines += ['<!-- kanto-startup-preloads:end -->']
path = root / 'index.html'
html = path.read_text(encoding='utf-8')
html = re.sub(r'\n?<!-- kanto-startup-preloads:begin -->.*?<!-- kanto-startup-preloads:end -->\n?', '', html, flags=re.S)
html = html.replace('</head>', '\n' + '\n'.join(lines) + '\n</head>')
path.write_text(html, encoding='utf-8')
print(f'Prepared {len(modules)} existing modules and {len(data)} critical JSON preloads')
