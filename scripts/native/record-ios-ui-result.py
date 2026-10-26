"""Record proof only after real XCTest success and exact hosted-source match."""
import hashlib
import json
import pathlib
import re
import subprocess
import urllib.request

root = pathlib.Path(__file__).resolve().parents[2]
evidence = root / 'native-evidence'
result_path = evidence / 'ios-ui-result.json'
result_path.write_text(json.dumps({'screenAssertions': False, 'validationCompleted': False}) + '\n', encoding='utf-8')
bundle = evidence / 'ios-ui-tests.xcresult'
summary_raw = subprocess.check_output([
    'xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(bundle)
], text=True)
summary = json.loads(summary_raw)
(evidence / 'ios-ui-summary.json').write_text(summary_raw, encoding='utf-8')
passed = summary.get('passedTests')
failed = summary.get('failedTests')
total = summary.get('totalTestCount')
assert isinstance(passed, int) and passed >= 1, 'No passed XCTest screen test exists'
assert failed == 0 and isinstance(total, int) and total >= 1, 'The XCTest run was empty or failed'
log = (evidence / 'ios-ui-tests.log').read_text(encoding='utf-8')
assert re.search(r'Test Case .*testHostedNavigationAndAnonymousAccountBoundary.* passed', log), 'The exact hosted-screen XCTest did not pass'
snapshot = json.loads((evidence / 'native-source-evidence.json').read_text(encoding='utf-8'))
source = (root / 'index.html').read_bytes()
bundled = (root / 'ios/App/App/public/index.html').read_bytes()
source_commit = (evidence / 'source-commit.txt').read_text().strip()
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == source_commit
assert subprocess.check_output(['git', 'show', 'HEAD:index.html']) == source, 'The reviewed source index changed after checkout'
source_sha = hashlib.sha256(source).hexdigest()
assert source == bundled, 'The compiled native web resource differs from reviewed source'
assert snapshot.get('exactSourceIndex') is True and snapshot.get('sourceIndexSHA256') == source_sha
config = json.loads((root / 'ios/App/App/capacitor.config.json').read_text(encoding='utf-8'))
assert config.get('server', {}).get('url') == 'https://tcghub.kr'
req = urllib.request.Request('https://tcghub.kr/?native-validation=' + source_sha[:16],
    headers={'User-Agent': 'TCGHUB-native-validation/1.0', 'Cache-Control': 'no-cache'})
with urllib.request.urlopen(req, timeout=25) as response:
    assert response.status == 200
    hosted = response.read().decode('utf-8')
def normalize(value):
    value = value.replace('\r\n', '\n')
    value = re.sub(r'<script\b[^>]*src=["\']https://static\.cloudflareinsights\.com/[^>]*>\s*</script>', '', value, flags=re.I)
    return value.replace('<!-- Cloudflare Pages Analytics -->', '')
hosted_matches = normalize(hosted) == normalize(source.decode('utf-8'))
result = {'screenAssertions': hosted_matches, 'validationCompleted': True, 'xctestPassed': True,
    'passedTests': passed, 'failedTests': failed, 'totalTestCount': total,
    'bundledSourceMatches': True, 'hostedSourceMatches': hosted_matches,
    'sourceIndexSHA256': source_sha,
    'sourceCommit': source_commit,
    'physicalDevice': False, 'oauthProviderSignIn': False,
    'accountOrHoldingsWrites': False}
result_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result))
assert hosted_matches, 'UI tests exercised another hosted web revision; deploy reviewed web source and rerun'
