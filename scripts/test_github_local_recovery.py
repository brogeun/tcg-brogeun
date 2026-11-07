"""Exercise failed transports, public-only fallbacks and durable price recovery."""
import base64
import copy
from datetime import datetime, timedelta
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.error import HTTPError, URLError
from scripts import run_kream_local as local


def fixture(root):
    from scripts import test_run_kream_local
    return test_run_kream_local.LocalCollectorTests().fixture(root)


def fresh_generation(root):
    manifest = local.collector.validate_bundle(root)
    stamp = datetime.now(local.collector.KST).isoformat()
    staged = {}
    for card in manifest['cards']:
        history = local.collector.unpack_history(json.loads((root / card['file'].lstrip('/')).read_bytes()))
        history.update(snapshot_started_at=stamp, last_observed_at=stamp,
                       target_count=len(history['rows']), earliest_date=history['rows'][-1]['date'],
                       latest_date=history['rows'][0]['date'])
        staged[card['id']] = history
    local.collector.publish_generation(root, manifest, staged, stamp)


class Response(io.BytesIO):
    def geturl(self): return 'https://api.github.com/repos/brogeun/tcg-brogeun/git/ref/heads/main'


class GithubTransportTests(unittest.TestCase):
    def records(self):
        events = []
        return events, lambda code, **details: events.append({'code': code, **details})

    def test_cli_timeout_uses_public_reader_and_skips_cli_for_remaining_price_reads(self):
        events, emit = self.records()
        api = local.GhApi('gh', emit)
        with mock.patch.object(local, 'run_github_command', side_effect=subprocess.TimeoutExpired('gh', 20)), \
             mock.patch.object(local.urlrequest, 'urlopen', side_effect=lambda *_a, **_k: Response(b'{"ok":true}')) as http:
            self.assertEqual(api('git/ref/heads/main'), {'ok': True})
            api('git/commits/' + '1'*40)
            self.assertEqual(http.call_count, 2)
        self.assertIn('github_public_read_fallback', [event['code'] for event in events])

    def test_public_server_failure_retries_but_does_not_expose_response_body(self):
        events, emit = self.records()
        api = local.GhApi('gh', emit)
        api.public_reads = True
        error = HTTPError('https://api.github.com', 503, 'PRIVATE-ERROR', {}, io.BytesIO(b'PRIVATE-BODY'))
        with mock.patch.object(local.urlrequest, 'urlopen', side_effect=[error, Response(b'{"ok":1}')]) as http, \
             mock.patch.object(local.time, 'sleep') as sleep:
            self.assertEqual(api('git/ref/heads/main'), {'ok': 1})
        self.assertEqual(http.call_count, 2)
        sleep.assert_called_once_with(2)
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_rate_limit_honors_retry_after_and_blocks_all_further_requests(self):
        api = local.GhApi('gh')
        api.public_reads = True
        error = HTTPError('https://api.github.com', 429, 'PRIVATE', {'Retry-After': '120'}, io.BytesIO())
        with mock.patch.object(local.urlrequest, 'urlopen', side_effect=error) as http, \
             mock.patch.object(local, 'run_github_command') as cli, mock.patch.object(local.time, 'sleep') as sleep:
            with self.assertRaises(local.LocalError) as caught: api('git/ref/heads/main')
            self.assertEqual(caught.exception.code, 'github_rate_limited')
            self.assertEqual(caught.exception.details['retry_after_seconds'], 120)
            with self.assertRaises(local.LocalError): api('git/trees', method='POST', payload={})
        self.assertEqual(http.call_count, 1)
        cli.assert_not_called()
        sleep.assert_not_called()

    def test_forbidden_read_is_not_retried(self):
        api = local.GhApi('gh')
        api.public_reads = True
        error = HTTPError('https://api.github.com', 403, 'PRIVATE', {}, io.BytesIO())
        with mock.patch.object(local.urlrequest, 'urlopen', side_effect=error) as http:
            with self.assertRaises(local.LocalError) as caught: api('git/ref/heads/main')
        self.assertEqual(caught.exception.code, 'github_forbidden')
        self.assertEqual(caught.exception.details['http_status'], 403)
        self.assertEqual(http.call_count, 1)

    def test_post_timeout_never_uses_public_transport_or_blind_retries(self):
        api = local.GhApi('gh')
        with mock.patch.object(local, 'run_github_command', side_effect=subprocess.TimeoutExpired('gh', 20, output=b'PRIVATE')) as cli, \
             mock.patch.object(local.urlrequest, 'urlopen') as http:
            with self.assertRaises(local.LocalError) as caught: api('git/trees', method='POST', payload={'x': 'PRIVATE'})
        self.assertEqual(caught.exception.code, 'github_timeout')
        self.assertEqual(cli.call_count, 1)
        http.assert_not_called()

    def test_public_fallback_never_sends_authorization_or_cookies(self):
        api = local.GhApi('gh')
        requests = []
        def get(request, **_kwargs):
            requests.append(request)
            return Response(b'{"ok":1}')
        result = SimpleNamespace(returncode=1, stdout=b'', stderr=b'HTTP 401: PRIVATE-TOKEN')
        with mock.patch.object(local, 'run_github_command', return_value=result), \
             mock.patch.object(local.urlrequest, 'urlopen', side_effect=get):
            self.assertEqual(api('git/ref/heads/main'), {'ok': 1})
        headers = {name.lower(): value for name, value in requests[0].header_items()}
        self.assertNotIn('authorization', headers)
        self.assertNotIn('cookie', headers)
        self.assertNotIn('PRIVATE', requests[0].full_url + json.dumps(headers))

    def test_non_price_endpoints_cannot_use_anonymous_fallback(self):
        api = local.GhApi('gh')
        with mock.patch.object(local, 'run_github_command', side_effect=subprocess.TimeoutExpired('gh', 20)), \
             mock.patch.object(local.urlrequest, 'urlopen') as http:
            with self.assertRaises(local.LocalError): api('contents/private.json?ref=' + '1'*40)
        http.assert_not_called()

    def test_invalid_http_json_is_not_retried_or_logged(self):
        events, emit = self.records()
        api = local.GhApi('gh', emit)
        api.public_reads = True
        with mock.patch.object(local.urlrequest, 'urlopen', return_value=Response(b'PRIVATE-BODY')) as http:
            with self.assertRaises(local.LocalError) as caught: api('git/ref/heads/main')
        self.assertEqual(caught.exception.code, 'invalid_github_response')
        self.assertEqual(http.call_count, 1)
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_shared_read_budget_stops_before_another_network_request(self):
        api = local.GhApi('gh')
        api.public_reads = True
        with mock.patch.object(local.time, 'monotonic', side_effect=[0, 100]), \
             mock.patch.object(local.urlrequest, 'urlopen') as http:
            with api.read_budget(), self.assertRaises(local.LocalError) as caught:
                api('git/ref/heads/main')
        self.assertEqual(caught.exception.code, 'github_timeout')
        http.assert_not_called()

    def test_cli_is_bounded_noninteractive_and_keeps_request_body_on_stdin(self):
        with mock.patch.object(local, 'run_github_command', return_value=SimpleNamespace(returncode=0, stdout=b'{}')) as run:
            local.GhApi('gh')('git/trees', method='POST', payload={'content': 'PRIVATE'})
        args, kwargs = run.call_args
        self.assertEqual(kwargs['timeout'], 20)
        self.assertEqual(kwargs['env']['GH_PROMPT_DISABLED'], '1')
        self.assertEqual(kwargs['env']['GH_DEBUG'], '')
        self.assertNotIn('PRIVATE', ' '.join(args[0]))
        self.assertEqual(json.loads(kwargs['input']), {'content': 'PRIVATE'})

    def test_public_redirect_cannot_leave_this_repository(self):
        api=local.GhApi('gh');api.public_reads=True
        response=Response(b'{}');response.geturl=lambda:'https://api.github.com/repos/other/project/git/ref/heads/main'
        with mock.patch.object(local.urlrequest,'urlopen',return_value=response):
            with self.assertRaises(local.LocalError) as caught:api('git/ref/heads/main')
        self.assertEqual(caught.exception.code,'invalid_github_response')

    def test_cli_timeout_cleanup_does_not_wait_for_inherited_pipe_handles(self):
        process=mock.Mock(returncode=None)
        process.wait.side_effect=subprocess.TimeoutExpired('gh',20)
        with mock.patch.object(local.subprocess,'Popen',return_value=process) as popen:
            with self.assertRaises(subprocess.TimeoutExpired):local.run_github_command(['gh'],input=b'PRIVATE',timeout=20)
            kwargs=popen.call_args.kwargs
            self.assertNotEqual(kwargs['stdin'],subprocess.PIPE)
            self.assertNotEqual(kwargs['stdout'],subprocess.PIPE)
            self.assertNotEqual(kwargs['stderr'],subprocess.PIPE)
        process.kill.assert_called_once();process.communicate.assert_not_called()

    def test_real_child_process_timeout_returns_without_waiting_for_normal_exit(self):
        import time
        before=time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            local.run_github_command([sys.executable,'-c','import time;time.sleep(5)'],timeout=0.15)
        self.assertLess(time.monotonic()-before,3)

    def test_cli_temporary_streams_return_bounded_output(self):
        result=local.run_github_command([sys.executable,'-c','import sys;print("ok");print("safe",file=sys.stderr)'],timeout=5)
        self.assertEqual(result.returncode,0)
        self.assertEqual(result.stdout.strip(),b'ok');self.assertEqual(result.stderr.strip(),b'safe')


class DurablePriceRecoveryTests(unittest.TestCase):
    baseline = {'sha': '1'*40, 'tree': '2'*40}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'state'
        self.root = Path(self.temp.name) / 'source'
        self.state.mkdir()
        self.root.mkdir()
        self.files = fixture(self.root)
        self.events = []

    def emit(self, code, **details): self.events.append({'code': code, **details})

    def pending(self):
        input_hashes = local.file_hashes(self.root)
        fresh_generation(self.root)
        directory, _ = local.snapshot_record(self.state, 'pending-publication', self.root,
                                              input_hashes=input_hashes, baseline=self.baseline)
        return directory, input_hashes

    def reset_input(self):
        for name, raw in self.files.items(): (self.root / name).write_bytes(raw)

    def test_verified_cache_allows_collection_after_remote_read_failure(self):
        local.cache_baseline(self.state, self.root, self.baseline)
        out = Path(self.temp.name) / 'restored'
        def offline(_endpoint): raise local.LocalError('github_network_failed')
        baseline, cached = local.load_baseline(offline, out, self.state, self.emit)
        self.assertTrue(cached)
        self.assertEqual(baseline, self.baseline)
        self.assertEqual({name:(out/name).read_bytes() for name in local.FILES}, self.files)
        self.assertTrue(self.events[-1]['publication_requires_fresh_reference'])

    def test_modified_cache_is_rejected_before_copying_any_price_file(self):
        directory, _ = local.cache_baseline(self.state, self.root, self.baseline)
        (directory / local.FILES[-1]).write_text('PRIVATE-CORRUPTION')
        out = Path(self.temp.name) / 'restored'
        def offline(_endpoint): raise local.LocalError('github_network_failed')
        with self.assertRaises(local.LocalError): local.load_baseline(offline, out, self.state, self.emit)
        self.assertFalse(out.exists())
        self.assertNotIn('PRIVATE', json.dumps(self.events))

    def test_expired_cache_is_rejected(self):
        directory, record = local.cache_baseline(self.state, self.root, self.baseline)
        record['created_at'] = (datetime.now(local.collector.KST)-timedelta(days=8)).isoformat()
        (directory/'record.json').write_bytes(local.collector.encoded(record))
        with self.assertRaises(local.LocalError): local.read_snapshot(self.state, 'baseline-cache', timedelta(days=7))

    def test_cache_from_another_repository_is_rejected(self):
        directory, record = local.cache_baseline(self.state, self.root, self.baseline)
        record['repository'] = 'someone/else'
        (directory/'record.json').write_bytes(local.collector.encoded(record))
        with self.assertRaises(local.LocalError): local.read_snapshot(self.state, 'baseline-cache', timedelta(days=7))

    def test_completed_pending_prices_resume_after_a_process_restart(self):
        directory, hashes = self.pending()
        candidate = {name:(self.root/name).read_bytes() for name in local.FILES}
        self.reset_input()
        resumed = local.reuse_pending(self.state, self.root, hashes, self.emit)
        self.assertEqual(resumed, directory)
        self.assertEqual({name:(self.root/name).read_bytes() for name in local.FILES}, candidate)

    def test_offline_publication_cannot_mutate_github_and_keeps_pending_prices(self):
        directory, hashes = self.pending()
        before = {name:(directory/name).read_bytes() for name in local.FILES}
        calls=[]
        def offline(endpoint, **kwargs):
            calls.append((endpoint,kwargs))
            raise local.LocalError('github_timeout')
        with self.assertRaises(local.LocalError): local.publication_baseline(offline,self.state,self.baseline,hashes)
        self.assertEqual(calls,[('git/ref/heads/main',{})])
        self.assertEqual(before,{name:(directory/name).read_bytes() for name in local.FILES})

    def test_new_remote_trades_block_rebasing_an_old_pending_generation(self):
        _directory, hashes = self.pending()
        latest = {'sha':'3'*40,'tree':'4'*40}
        def fetch(_api, destination):
            fixture(destination)
            (destination/local.FILES[1]).write_bytes((destination/local.FILES[1]).read_bytes()+b' ')
            return latest
        with mock.patch.object(local,'fetch_baseline',side_effect=fetch):
            with self.assertRaises(local.LocalError) as caught:
                local.publication_baseline(lambda _e:{'object':{'sha':latest['sha']}},self.state,self.baseline,hashes)
        self.assertEqual(caught.exception.code,'github_baseline_changed')

    def test_unrelated_main_changes_rebase_onto_current_commit_without_replacing_prices(self):
        _directory, hashes = self.pending()
        latest = {'sha':'3'*40,'tree':'4'*40}
        def fetch(_api, destination): fixture(destination);return latest
        with mock.patch.object(local,'fetch_baseline',side_effect=fetch):
            accepted=local.publication_baseline(lambda _e:{'object':{'sha':latest['sha']}},self.state,self.baseline,hashes)
        self.assertEqual(accepted,latest)

    def test_pending_prices_do_not_resume_against_a_different_input_generation(self):
        self.pending()
        self.reset_input()
        before=local.file_hashes(self.root)
        self.assertIsNone(local.reuse_pending(self.state,self.root,{**before,local.FILES[0]:'0'*64},self.emit))
        self.assertEqual(local.file_hashes(self.root),before)

    def test_requested_publication_is_not_dispatched_twice(self):
        directory,hashes=self.pending()
        local.mark_publication_requested(self.state,directory,'4'*40)
        self.reset_input()
        with self.assertRaises(local.LocalError) as caught:
            local.reuse_pending(self.state,self.root,hashes,self.emit)
        self.assertEqual(caught.exception.code,'github_publication_confirmation_pending')

    def test_uncertain_dispatch_is_not_blindly_replayed(self):
        directory,hashes=self.pending()
        pointer={'schemaVersion':1,'generation':directory.name,'state':'dispatching','source_commit':'4'*40}
        (self.state/'pending-publication/latest.json').write_bytes(local.collector.encoded(pointer))
        self.reset_input()
        with self.assertRaises(local.LocalError): local.reuse_pending(self.state,self.root,hashes,self.emit)
        self.assertEqual(local.file_hashes(self.root),hashes)

    def test_scheduled_run_does_not_publish_yesterdays_saved_collection(self):
        directory,hashes=self.pending()
        old=(datetime.now(local.collector.KST).replace(hour=0,minute=0,second=0)-timedelta(hours=1)).isoformat()
        for name in local.FILES[:2]:
            value=json.loads((directory/name).read_bytes());value['last_success_at']=old
            (directory/name).write_bytes(local.collector.encoded(value))
        record=json.loads((directory/'record.json').read_bytes());record['hashes']=local.file_hashes(directory)
        (directory/'record.json').write_bytes(local.collector.encoded(record))
        self.reset_input()
        self.assertIsNone(local.reuse_pending(self.state,self.root,hashes,self.emit,today_only=True))

    def test_real_upload_checkpoints_before_dispatch_and_keeps_only_public_data(self):
        fresh_generation(self.root)
        calls=[];checkpoints=[]
        def api(endpoint,**kwargs):
            calls.append(endpoint)
            if endpoint.endswith('dispatches'):
                self.assertEqual(checkpoints,[('4'*40,'1'*40)])
                raise local.LocalError('github_timeout',operation='POST')
            return {'sha':'3'*40 if endpoint=='git/trees' else '4'*40}
        with self.assertRaises(local.LocalError):
            local.upload_generation(api,self.root,self.baseline,before_dispatch=lambda s,b:checkpoints.append((s,b)))
        self.assertEqual(calls[-1],'actions/workflows/kream-local-publish.yml/dispatches')

    def test_recent_save_cannot_relabel_an_old_collection_as_fresh(self):
        self.pending()
        pointer=json.loads((self.state/'pending-publication/latest.json').read_bytes())
        directory=self.state/'pending-publication'/pointer['generation']
        old=(datetime.now(local.collector.KST)-timedelta(days=2)).isoformat()
        for name in local.FILES[:2]:
            value=json.loads((directory/name).read_bytes());value['last_success_at']=old
            (directory/name).write_bytes(local.collector.encoded(value))
        record=json.loads((directory/'record.json').read_bytes());record['hashes']=local.file_hashes(directory)
        (directory/'record.json').write_bytes(local.collector.encoded(record))
        self.reset_input()
        self.assertIsNone(local.reuse_pending(self.state,self.root,local.file_hashes(self.root),self.emit))

    def test_failed_cache_write_keeps_the_previous_verified_pointer(self):
        local.cache_baseline(self.state,self.root,self.baseline)
        pointer=(self.state/'baseline-cache/latest.json').read_bytes()
        with mock.patch.object(local.collector,'replace_file',side_effect=OSError('PRIVATE')):
            with self.assertRaises(OSError): local.cache_baseline(self.state,self.root,self.baseline)
        self.assertEqual((self.state/'baseline-cache/latest.json').read_bytes(),pointer)
        local.read_snapshot(self.state,'baseline-cache',timedelta(days=7))

    def test_execute_replays_saved_prices_without_reopening_browser_or_logging_in(self):
        directory,_hashes=self.pending()
        def load(_api,destination,_state,_emit): fixture(destination);return self.baseline,False
        browser=mock.Mock(side_effect=AssertionError('Browser must not reopen'))
        args=SimpleNamespace(run=True,setup=False,scheduled=False,gh_path='gh')
        with mock.patch.object(local.shutil,'which',return_value='gh'), \
             mock.patch.object(local,'load_baseline',side_effect=load), \
             mock.patch.object(local,'publication_baseline',return_value=self.baseline), \
             mock.patch.object(local,'upload_generation',return_value='4'*40) as upload, \
             mock.patch.dict(sys.modules,{'playwright.sync_api':SimpleNamespace(sync_playwright=browser)}):
            self.assertEqual(local.execute(args,self.state,self.emit),0)
        browser.assert_not_called();upload.assert_called_once()
        pointer=json.loads((self.state/'pending-publication/latest.json').read_bytes())
        self.assertEqual(pointer['generation'],directory.name);self.assertEqual(pointer['state'],'requested')

    def test_cached_collection_is_saved_before_offline_publication_is_rejected(self):
        context=SimpleNamespace(close=mock.Mock())
        chromium=SimpleNamespace(launch_persistent_context=mock.Mock(return_value=context))
        runtime=mock.MagicMock();runtime.__enter__.return_value=SimpleNamespace(chromium=chromium)
        def load(_api,destination,_state,_emit):fixture(destination);return self.baseline,True
        def collect(_context,destination,_emit):fresh_generation(destination);return local.collector.validate_bundle(destination)
        args=SimpleNamespace(run=True,setup=False,scheduled=False,gh_path='gh')
        with mock.patch.object(local.shutil,'which',return_value='gh'), \
             mock.patch.object(local,'load_baseline',side_effect=load), \
             mock.patch.object(local,'collect_generation',side_effect=collect), \
             mock.patch.object(local,'publication_baseline',side_effect=local.LocalError('github_network_failed')), \
             mock.patch.object(local,'upload_generation') as upload, \
             mock.patch.dict(sys.modules,{'playwright.sync_api':SimpleNamespace(sync_playwright=lambda:runtime)}):
            with self.assertRaises(local.LocalError):local.execute(args,self.state,self.emit)
        context.close.assert_called_once();upload.assert_not_called()
        directory,record=local.read_snapshot(self.state,'pending-publication',timedelta(days=1))
        self.assertEqual(local.collector.validate_bundle(directory)['collected_trade_count'],7)
        self.assertEqual(record['input_hashes'],{name:local.hashlib.sha256(raw).hexdigest() for name,raw in self.files.items()})

    def test_dispatch_timeout_keeps_checkpoint_and_next_execute_does_not_dispatch_again(self):
        self.pending()
        def load(_api,destination,_state,_emit):fixture(destination);return self.baseline,False
        def upload(_api,_root,_baseline,*,before_dispatch):
            before_dispatch('4'*40,'1'*40)
            raise local.LocalError('github_timeout',operation='POST')
        args=SimpleNamespace(run=True,setup=False,scheduled=False,gh_path='gh')
        with mock.patch.object(local.shutil,'which',return_value='gh'), \
             mock.patch.object(local,'load_baseline',side_effect=load), \
             mock.patch.object(local,'publication_baseline',return_value=self.baseline), \
             mock.patch.object(local,'upload_generation',side_effect=upload) as mutation:
            with self.assertRaises(local.LocalError):local.execute(args,self.state,self.emit)
            with self.assertRaises(local.LocalError) as caught:local.execute(args,self.state,self.emit)
        self.assertEqual(caught.exception.code,'github_publication_confirmation_pending')
        self.assertEqual(mutation.call_count,1)
        pointer=json.loads((self.state/'pending-publication/latest.json').read_bytes())
        self.assertEqual(pointer['state'],'dispatching')

    def test_definitive_dispatch_authentication_rejection_can_resume_after_signin(self):
        self.pending()
        def load(_api,destination,_state,_emit):fixture(destination);return self.baseline,False
        def upload(_api,_root,_baseline,*,before_dispatch):
            before_dispatch('4'*40,'1'*40)
            raise local.LocalError('github_auth_required',http_status=401,operation='POST')
        args=SimpleNamespace(run=True,setup=False,scheduled=False,gh_path='gh')
        with mock.patch.object(local.shutil,'which',return_value='gh'), \
             mock.patch.object(local,'load_baseline',side_effect=load), \
             mock.patch.object(local,'publication_baseline',return_value=self.baseline), \
             mock.patch.object(local,'upload_generation',side_effect=upload):
            with self.assertRaises(local.LocalError):local.execute(args,self.state,self.emit)
        pointer=json.loads((self.state/'pending-publication/latest.json').read_bytes())
        self.assertEqual(pointer['state'],'pending')

    def test_error_hook_gets_only_safe_structured_details(self):
        error=local.LocalError('github_timeout',transport='cli',timeout_seconds=20,stderr='PRIVATE')
        with mock.patch.object(local,'execute',side_effect=error), mock.patch('sys.stdout',new=io.StringIO()) as output:
            self.assertEqual(local.main(['--run','--state-root',str(self.state)],event_hook=self.emit),1)
        self.assertEqual(self.events[-1]['code'],'github_timeout')
        self.assertEqual(self.events[-1]['timeout_seconds'],20)
        self.assertNotIn('PRIVATE',output.getvalue()+json.dumps(self.events))

    def test_scheduled_retry_releases_profile_lock_and_keeps_failure_log(self):
        args=['--run','--scheduled','--state-root',str(self.state)]
        def wait(_seconds):
            with local.profile_lock(self.state/'runner.lock'):pass
        with mock.patch.object(local,'execute',side_effect=[local.LocalError('github_timeout'),0]) as execute, \
             mock.patch.object(local.time,'sleep',side_effect=wait) as sleep, \
             mock.patch('sys.stdout',new=io.StringIO()):
            self.assertEqual(local.main(args,event_hook=self.emit),0)
        self.assertEqual(execute.call_count,2);sleep.assert_called_once_with(600)
        records=[json.loads(line) for line in (self.state/'logs/latest.log').read_text().splitlines()]
        self.assertIn('github_timeout',[row['code'] for row in records])
        self.assertEqual([row['attempt'] for row in records if row['code']=='starting_collection'],[1,2])

    def test_scheduled_retry_is_limited_to_three_attempts(self):
        with mock.patch.object(local,'execute',side_effect=local.LocalError('github_network_failed')) as execute, \
             mock.patch.object(local.time,'sleep') as sleep, mock.patch('sys.stdout',new=io.StringIO()):
            self.assertEqual(local.main(['--run','--scheduled','--state-root',str(self.state)]),1)
        self.assertEqual(execute.call_count,3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list],[600,1200])

    def test_authentication_error_does_not_loop_or_request_kream_login(self):
        with mock.patch.object(local,'execute',side_effect=local.LocalError('github_auth_required')) as execute, \
             mock.patch.object(local.time,'sleep') as sleep, mock.patch('sys.stdout',new=io.StringIO()):
            self.assertEqual(local.main(['--run','--scheduled','--state-root',str(self.state)]),1)
        self.assertEqual(execute.call_count,1);sleep.assert_not_called()

    def test_scheduled_retry_respects_server_delay(self):
        error=local.LocalError('github_rate_limited',retry_after_seconds=1800)
        with mock.patch.object(local,'execute',side_effect=[error,0]),mock.patch.object(local.time,'sleep') as sleep, \
             mock.patch('sys.stdout',new=io.StringIO()):
            self.assertEqual(local.main(['--run','--scheduled','--state-root',str(self.state)]),0)
        sleep.assert_called_once_with(1800)

    def test_retry_later_than_task_budget_is_saved_as_deferred(self):
        error=local.LocalError('github_rate_limited',retry_after_seconds=9000)
        with mock.patch.object(local,'execute',side_effect=error),mock.patch.object(local.time,'sleep') as sleep, \
             mock.patch('sys.stdout',new=io.StringIO()):
            self.assertEqual(local.main(['--run','--scheduled','--state-root',str(self.state)],event_hook=self.emit),1)
        sleep.assert_not_called();self.assertEqual(self.events[-1]['code'],'github_retry_deferred')


if __name__=='__main__': unittest.main()
