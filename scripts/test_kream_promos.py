import copy
import contextlib
from datetime import datetime
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from scripts import collect_kream_promos as collector
from scripts.collect_kream_promos import KST, IDS, parse_row, validate_bundle, validate_new_rows, unpack_history, pack_history
from scripts.publish_data_snapshot import daily_path, KOREAN_PROMO_FILES

def load_tests(loader, standard_tests, pattern):
    # Existing explicit CI/publication suites also exercise partial generations.
    standard_tests.addTests(loader.loadTestsFromName('scripts.test_kream_partial'))
    return standard_tests

class KreamPromosTests(unittest.TestCase):
    def test_full_published_snapshot_counts_and_options(self):
        root=Path(__file__).resolve().parents[1]
        data=validate_bundle(root)
        self.assertEqual(tuple(c['id'] for c in data['cards']),IDS)
        self.assertGreaterEqual(data['collected_trade_count'],16363)
        self.assertNotIn('937107',IDS)
        self.assertTrue(all(not daily_path(p) for p in KOREAN_PROMO_FILES))
        ex=unpack_history(json.loads((root/'data/korean-promos/934334.json').read_bytes()))
        self.assertTrue(all(not r['option'].startswith('Ungraded') for r in ex['rows']))
        ditto=json.loads((root/'data/korean-promos/508949.json').read_bytes())
        self.assertIn('ONE SIZE',ditto['counts_by_exact_option'])

    def test_lossless_dictionary_encoding(self):
        root=Path(__file__).resolve().parents[1]
        for ident in IDS:
            packed=json.loads((root/f'data/korean-promos/{ident}.json').read_bytes())
            expanded=unpack_history(packed)
            self.assertEqual(unpack_history(pack_history(expanded)),expanded)

    def test_duplicate_transactions_are_not_deduplicated(self):
        row={'date':'2026-10-31','option':'Ungraded A','price_krw':29000,'express_shipping':False}
        old={'rows':[row,row]}
        with self.assertRaises(ValueError):validate_new_rows(old,[row])
        validate_new_rows(old,[row,row,row])
        changed=copy.deepcopy(row);changed['option']='PSA 10'
        with self.assertRaises(ValueError):validate_new_rows(old,[row,changed])

    def test_source_date_and_relative_labels(self):
        anchor=datetime(2026,11,1,0,20,tzinfo=KST)
        source={'date_raw':'빠른배송26/10/29','option':'Ungraded A (Pack Ver.)','price':'30,000원','express_shipping':True}
        self.assertEqual(parse_row(source,anchor)['date'],'2026-10-29')
        source['date_raw']='1시간 전'
        self.assertEqual(parse_row(source,anchor)['date'],'2026-10-31')
        source['date_raw']='확인 중'
        with self.assertRaises(ValueError):parse_row(source,anchor)

class AuthenticatedCollectorTests(unittest.TestCase):
    state={'cookies':[{'name':'auth','value':'TEST-PRIVATE-VALUE','domain':'.kream.co.kr','path':'/'}],'origins':[]}

    def fixture(self,directory):
        root=Path(directory);source=Path(__file__).resolve().parents[1]
        shutil.copytree(source/'data/korean-promos',root/'data/korean-promos')
        for name in ('korean-promos.json','korean-promos-health.json'):
            shutil.copyfile(source/'data'/name,root/'data'/name)
        return root

    def prices(self,root):
        return {str(p.relative_to(root)):p.read_bytes() for p in (root/'data').rglob('*.json')
                if p.name!='korean-promos-health.json'}

    def page(self,statuses=(200,),visible_gate=False):
        page=mock.Mock(url='https://kream.co.kr/products/1096144')
        page.goto.side_effect=[SimpleNamespace(status=s) for s in statuses]
        page.get_by_text.return_value.all.return_value=[mock.Mock(is_visible=lambda:visible_gate)]
        return page

    def test_session_is_required_and_scoped_to_kream(self):
        for value in ('', 'TEST-PRIVATE-VALUE', '[]', '{"cookies":null}', '{"cookies":[],"origins":[]}'):
            with self.assertRaises(collector.CollectionError) as caught:collector.session_state(value)
            self.assertNotIn('TEST-PRIVATE-VALUE',str(caught.exception))
        state=copy.deepcopy(self.state)
        state['cookies'] += [{'domain':'.notkream.co.kr','value':'OTHER-PRIVATE'}]
        state['origins']=[{'origin':'https://kream.co.kr','localStorage':[{'name':'token','value':'TEST'}]},
                          {'origin':'https://evil-kream.co.kr','localStorage':[]}]
        result=collector.session_state(json.dumps(state))
        self.assertEqual(len(result['cookies']),1)
        self.assertEqual(len(result['origins']),1)
        self.assertNotIn('OTHER-PRIVATE',json.dumps(result))

    def test_transient_500_retries_same_context(self):
        page=self.page((500,503,200))
        collector.open_product(page,{'id':'1096144','source_url':page.url})
        self.assertEqual(page.goto.call_count,3)
        self.assertEqual(page.wait_for_timeout.call_args_list,[mock.call(5000),mock.call(15000)])

    def test_access_denial_and_login_gate_stop_without_retry(self):
        for status in (401,403,429):
            page=self.page((status,))
            with self.assertRaises(collector.CollectionError) as caught:
                collector.open_product(page,{'id':'1096144','source_url':page.url})
            self.assertEqual(caught.exception.code,'access_denied')
            self.assertEqual(page.goto.call_count,1)
        page=self.page(visible_gate=True)
        with self.assertRaises(collector.CollectionError) as caught:
            collector.open_product(page,{'id':'1096144','source_url':page.url})
        self.assertEqual(caught.exception.code,'session_expired')
        pattern=page.get_by_text.call_args.args[0]
        self.assertIsNotNone(pattern.search('모든 시세는 로그인 후 확인 가능합니다.'))
        page.url='https://kream.co.kr/login?returnUrl=products'
        with self.assertRaises(collector.CollectionError):collector.require_login_access(page)

    def test_preflight_never_advances_success_or_leaks_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root=self.fixture(directory);before=self.prices(root)
            for value,expected in (('',2),('TEST-PRIVATE-VALUE',2),(json.dumps(self.state),0)):
                health_before=(root/'data/korean-promos-health.json').read_bytes()
                stream=io.StringIO()
                with mock.patch.dict(os.environ,{'KREAM_STORAGE_STATE':value,'GITHUB_OUTPUT':str(root/'output')}),mock.patch.object(sys,'argv',['collector','--root',str(root),'--preflight']),contextlib.redirect_stderr(stream),contextlib.redirect_stdout(stream):
                    self.assertEqual(collector.main(),expected)
                self.assertEqual(self.prices(root),before)
                health=(root/'data/korean-promos-health.json').read_bytes()
                self.assertNotIn('TEST-PRIVATE-VALUE',stream.getvalue()+health.decode())
                if expected==0:self.assertEqual(health,health_before)
                else:self.assertEqual(json.loads(health)['status'],'failed')

    def test_last_product_failure_retains_entire_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=self.fixture(directory);before=self.prices(root)
            manifest=collector.validate_bundle(root)
            histories=[collector.unpack_history(json.loads((root/c['file'].lstrip('/')).read_bytes())) for c in manifest['cards']]
            manager=mock.MagicMock()
            module=SimpleNamespace(sync_playwright=lambda:manager)
            with mock.patch.dict(sys.modules,{'playwright':SimpleNamespace(),'playwright.sync_api':module}),mock.patch.dict(os.environ,{'KREAM_STORAGE_STATE':json.dumps(self.state)}),mock.patch.object(sys,'argv',['collector','--root',str(root)]),mock.patch.object(collector,'collect',side_effect=histories[:6]+[collector.CollectionError('session_expired','KREAM requires login.')]),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(collector.main(),2)
            self.assertEqual(self.prices(root),before)
            health=json.loads((root/'data/korean-promos-health.json').read_bytes())
            self.assertEqual(health['failed_product_id'],'508949')
            self.assertEqual(health['last_success_at'],manifest['last_success_at'])

    def staged(self,root,manifest):
        staged={c['id']:collector.unpack_history(json.loads((root/c['file'].lstrip('/')).read_bytes())) for c in manifest['cards']}
        data=staged['1096144'];data['rows'].insert(0,copy.deepcopy(data['rows'][0]))
        data['collected_count']+=1;data['counts_by_exact_option'][data['rows'][0]['option']]+=1
        return staged

    def test_generation_write_failure_rolls_back_prices(self):
        with tempfile.TemporaryDirectory() as directory:
            root=self.fixture(directory);before=self.prices(root);manifest=collector.validate_bundle(root)
            staged=self.staged(root,manifest);real=collector.replace_file;calls=0
            def fail_once(path,raw):
                nonlocal calls
                calls+=1
                if calls==4:raise OSError('simulated write failure')
                return real(path,raw)
            with mock.patch.object(collector,'replace_file',side_effect=fail_once),self.assertRaises(OSError):
                collector.publish_generation(root,manifest,staged,'test')
            self.assertEqual(self.prices(root),before)
            collector.validate_bundle(root)

    def test_health_mismatch_rejects_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=self.fixture(directory)
            health=json.loads((root/'data/korean-promos-health.json').read_bytes())
            health['last_success_at']='2099-01-01T00:00:00Z'
            (root/'data/korean-promos-health.json').write_text(json.dumps(health))
            with self.assertRaisesRegex(ValueError,'Health and history generation differ'):
                collector.validate_bundle(root)

    def test_session_upload_uses_stdin_and_excludes_third_party_state(self):
        from scripts.setup_kream_session import upload_session
        state=copy.deepcopy(self.state)
        state['cookies'].append({'domain':'.unrelated.example','value':'OTHER-PRIVATE'})
        with mock.patch('scripts.setup_kream_session.subprocess.run',return_value=SimpleNamespace(returncode=0)) as run:
            upload_session(state)
        args=run.call_args
        self.assertNotIn('TEST-PRIVATE-VALUE',' '.join(args.args[0]))
        self.assertIn(b'TEST-PRIVATE-VALUE',args.kwargs['input'])
        self.assertNotIn(b'OTHER-PRIVATE',args.kwargs['input'])
        self.assertTrue(args.kwargs['capture_output'])

    def test_success_publishes_complete_generation_and_keeps_repeated_trade(self):
        with tempfile.TemporaryDirectory() as directory:
            root=self.fixture(directory);manifest=collector.validate_bundle(root)
            result=collector.publish_generation(root,manifest,self.staged(root,manifest),'test')
            checked=collector.validate_bundle(root)
            self.assertEqual(checked,result)
            self.assertEqual(result['collected_trade_count'],manifest['collected_trade_count']+1)
            data=collector.unpack_history(json.loads((root/'data/korean-promos/1096144.json').read_bytes()))
            self.assertEqual(collector.signature(data['rows'][0]),collector.signature(data['rows'][1]))

    def test_fallback_skips_only_today_matching_success(self):
        now=datetime(2026,11,2,8,0,tzinfo=KST)
        manifest={'last_success_at':'2026-11-02T06:25:00+09:00'}
        health={'status':'success','last_success_at':manifest['last_success_at']}
        self.assertTrue(collector.already_collected_today(manifest,health,now))
        self.assertFalse(collector.already_collected_today(manifest,{**health,'status':'failed'},now))
        self.assertFalse(collector.already_collected_today(manifest,{**health,'last_success_at':'old'},now))
        self.assertFalse(collector.already_collected_today({'last_success_at':'2026-11-01T20:00:00+09:00'},health,now))

class DrawerProgressTests(unittest.TestCase):
    def test_loading_pause_below_old_count_is_not_an_end(self):
        page=mock.Mock();rows=mock.Mock()
        rows.count.side_effect=[50]*7+[100]*8
        rows.last.evaluate.return_value={'atBottom':True}
        report=mock.Mock()
        with mock.patch.object(collector,'require_login_access'):
            collector.load_drawer_rows(page,rows,100,report)
        self.assertGreaterEqual(rows.count.call_count,14)
        self.assertEqual(report.call_args.args[0],'history_loaded')
        self.assertEqual(report.call_args.kwargs['loaded_rows'],100)
        self.assertTrue(any('scrollTop-200' in c.args[0] for c in rows.last.evaluate.call_args_list))

    def test_truncated_drawer_never_becomes_complete(self):
        page=mock.Mock();rows=mock.Mock();rows.count.return_value=50
        rows.last.evaluate.return_value={'atBottom':True}
        with mock.patch.object(collector,'require_login_access'),self.assertRaisesRegex(ValueError,'Drawer did not reach'):
            collector.load_drawer_rows(page,rows,100,mock.Mock())

    def test_validation_reason_and_safe_counts_survive_local_failure(self):
        def incomplete(page,card,old,report):
            report('validating_history',loaded_rows=50,missing_previous_rows=20)
            raise ValueError('Source snapshot is incomplete or historical trades changed; preserved prior data')
        with mock.patch.object(collector,'_collect',side_effect=incomplete),self.assertRaises(collector.CollectionError) as caught:
            collector.collect(object(),{'id':'893073'},{'rows':[{}]*70})
        self.assertEqual(caught.exception.code,'historical_rows_missing')
        self.assertEqual(caught.exception.details,{'product_id':'893073','previous_rows':70,
            'stage':'validating_history','loaded_rows':50,'missing_previous_rows':20})

    def test_unrecognized_value_error_does_not_leak_private_text(self):
        with mock.patch.object(collector,'_collect',side_effect=ValueError('PRIVATE-AUTH')),self.assertRaises(collector.CollectionError) as caught:
            collector.collect(object(),{'id':'893073'},{'rows':[]})
        self.assertEqual(caught.exception.code,'source_row_invalid')
        self.assertNotIn('PRIVATE',str(caught.exception)+json.dumps(caught.exception.details))

if __name__=='__main__':unittest.main()
