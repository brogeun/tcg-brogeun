"""Compare the public Japanese set catalogue with the configured local sets.

This detects candidates only. Set-code mapping and card collection still require
review; this script does not add guessed codes or change catalogue files.
"""
import argparse
import ast
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
import urllib.request
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parent.parent
FETCH_SCRIPT = ROOT / 'scripts/fetch_set_cards.py'
TCGC_RECENT = 'https://www.tcgcollector.com/sets/jp'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')


def canonical_set_url(value):
    url = urlsplit(urljoin(TCGC_RECENT, value))
    if url.scheme != 'https' or url.netloc != 'www.tcgcollector.com':
        raise ValueError('Unexpected set catalogue host')
    match = re.fullmatch(r'/sets/([1-9][0-9]*)/([^/]+?)/?', url.path)
    if not match:
        raise ValueError('Invalid individual set link')
    return match.group(1), 'https://www.tcgcollector.com' + url.path.rstrip('/')


class SetLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current = None
        self.sets = {}

    def handle_starttag(self, tag, attributes):
        if tag != 'a':
            return
        values = dict(attributes)
        self.current = None
        try:
            sid, url = canonical_set_url(values.get('href', ''))
        except ValueError:
            return
        self.current = {'id': sid, 'url': url, 'title': values.get('title') or '', 'text': []}

    def handle_data(self, text):
        if self.current is not None:
            self.current['text'].append(text)

    def handle_endtag(self, tag):
        if tag != 'a' or self.current is None:
            return
        item, self.current = self.current, None
        name = ' '.join((''.join(item['text']).strip() or item['title']).split())
        if name and item['id'] not in self.sets:
            self.sets[item['id']] = (item['id'], urlsplit(item['url']).path, name)


def parse_remote_sets(html):
    parser = SetLinks()
    parser.feed(html)
    parser.close()
    if not parser.sets:
        raise ValueError('Public Japanese catalogue contained zero readable sets; source may be blocked or changed')
    return list(parser.sets.values())


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html'})
    with urllib.request.urlopen(request, timeout=30) as response:
        if urlsplit(response.geturl()).netloc != 'www.tcgcollector.com':
            raise ValueError('Unexpected catalogue redirect')
        body = response.read(8_000_001)
    if len(body) > 8_000_000:
        raise ValueError('Catalogue exceeded the byte limit')
    return body.decode('utf-8')


def discover_remote_sets():
    return parse_remote_sets(fetch(TCGC_RECENT))


def get_local_sets(path=None):
    """Read the literal 3-column (code, name, URL) catalogue without executing it."""
    tree = ast.parse(Path(path or FETCH_SCRIPT).read_text('utf-8-sig'))
    definitions = [node.value for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(name, ast.Name) and name.id == 'POKEMON_SETS' for name in node.targets)]
    if len(definitions) != 1:
        raise ValueError('Exactly one literal POKEMON_SETS definition is required')
    rows = ast.literal_eval(definitions[0])
    if not isinstance(rows, (list, tuple)) or not rows:
        raise ValueError('Local POKEMON_SETS catalogue is empty')
    result, codes, identities = [], set(), set()
    for row in rows:
        if not isinstance(row, (tuple, list)) or len(row) not in (2, 3):
            raise ValueError('Invalid local set row; expected code, optional name, and URL')
        code, url = row[0], row[-1]
        if not isinstance(code, str) or not code.strip() or not isinstance(url, str):
            raise ValueError('Local set code or URL is missing')
        sid, canonical = canonical_set_url(url)
        if code in codes or sid in identities:
            raise ValueError('Duplicate local set code or catalogue ID')
        codes.add(code)
        identities.add(sid)
        result.append((code, canonical))
    return result


def find_new_sets(remote, local):
    if not remote or not local:
        raise ValueError('Both remote and local catalogues must be nonempty before comparison')
    known = {canonical_set_url(url)[0] for _, url in local}
    result = []
    for sid, url, name in remote:
        identity, canonical = canonical_set_url(url)
        if sid != identity:
            raise ValueError('Remote set ID and link disagree')
        if identity not in known:
            result.append((sid, canonical, name, urlsplit(canonical).path.rsplit('/', 1)[-1]))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Detect candidates only; no files are changed')
    parser.parse_args(argv)
    print('tcgcollector 신규 포켓몬 세트 후보 감지')
    try:
        remote = discover_remote_sets()
        local = get_local_sets()
        print(f'원격: {len(remote)} 세트 / 로컬: {len(local)} 세트')
        new_sets = find_new_sets(remote, local)
    except (OSError, ValueError, SyntaxError) as error:
        print(f'❌ 목록을 확인하지 못했습니다. 신규 없음으로 처리하지 않습니다: {error}')
        return 1
    if not new_sets:
        print('✅ 신규 세트 없음. 두 목록을 실제로 읽고 비교했습니다.')
        return 0
    print(f'🆕 신규 후보 {len(new_sets)} 개:')
    for _, url, name, _ in new_sets[:20]:
        print(f'  - {name[:60]}  {url}')
    print('후보의 세트 코드와 범위를 검토해야 합니다. 자동 등록·카드 수집은 실행하지 않았습니다.')
    print('검토 후 scripts/fetch_set_cards.py의 POKEMON_SETS를 갱신하고 해당 세트를 수집하세요.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
