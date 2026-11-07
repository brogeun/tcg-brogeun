"""Send credential-free login-needed events through an isolated draft PR.

The event contains only a random incident ID, a timestamp and a fixed status.
The branch is never merged and cannot enter the nine-file price publication.
"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import uuid

PREFIX = '[TCGHUB KREAM LOGIN]'
BRANCH_PREFIX = 'kream-login-alert/'
MARKER = '.tcghub-status/kream-login-required.json'


class LoginAlerts:
    def __init__(self, api, directory, save):
        self.api = api
        self.path = Path(directory) / 'login-alert.json'
        self.save = save

    def _read(self):
        if not self.path.exists():
            return None
        state = json.loads(self.path.read_bytes())
        if not isinstance(state, dict) or state.get('schemaVersion') != 1:
            raise ValueError('Invalid login notification state')
        if not isinstance(state.get('incident_id'), str) or len(state['incident_id']) != 32:
            raise ValueError('Invalid login notification incident')
        if state.get('branch') != BRANCH_PREFIX + state['incident_id']:
            raise ValueError('Invalid login notification branch')
        return state

    def _store(self, state):
        self.save(self.path, state)

    def ensure_open(self, phone_status, *, relay_ready=False, relay_expires_at=None):
        state = self._read()
        if state and not state.get('resolved') and state.get('pull_request'):
            pull = self.api('pulls/' + str(int(state['pull_request'])))
            self._verify_pull(pull, state)
            if pull['state'] == 'open':
                created = datetime.fromisoformat(state['created_at'].replace('Z', '+00:00'))
                fresh = datetime.now(timezone.utc) - created < timedelta(minutes=90)
                relay_became_available = relay_ready and not state.get('relay_ready', False)
                if fresh and not relay_became_available:
                    return state
                self.api('pulls/' + str(int(state['pull_request'])),
                         method='PATCH', payload={'state': 'closed'})
        if not state or state.get('resolved') or state.get('pull_request'):
            incident = uuid.uuid4().hex
            state = {'schemaVersion': 1, 'incident_id': incident,
                     'branch': BRANCH_PREFIX + incident, 'resolved': False,
                     'relay_ready': bool(relay_ready),
                     'created_at': datetime.now(timezone.utc).isoformat()}
            self._store(state)
        if not state.get('source_commit'):
            base = self.api('git/ref/heads/main')['object']['sha']
            base_tree = self.api('git/commits/' + base)['tree']['sha']
            marker = {'schemaVersion': 1, 'kind': 'kream_owner_login_required',
                      'incident_id': state['incident_id'], 'status': 'waiting_for_owner',
                      'created_at': state['created_at'], 'phone_request_status': phone_status,
                      'chat_code_relay_available': bool(relay_ready),
                      'relay_expires_at': relay_expires_at,
                      'contains_credentials': False}
            tree = self.api('git/trees', method='POST', payload={
                'base_tree': base_tree, 'tree': [{'path': MARKER, 'mode': '100644',
                'type': 'blob', 'content': json.dumps(marker, separators=(',', ':')) + '\n'}]})
            commit = self.api('git/commits', method='POST', payload={
                'message': 'Record KREAM login-needed notification only',
                'tree': tree['sha'], 'parents': [base]})
            state['source_commit'] = commit['sha']
            self._store(state)
        if not state.get('branch_created'):
            try:
                self.api('git/refs', method='POST', payload={
                    'ref': 'refs/heads/' + state['branch'], 'sha': state['source_commit']})
            except Exception:
                # Recover only the exact ref after an ambiguous creation result.
                ref = self.api('git/ref/heads/' + state['branch'])
                if ref['object']['sha'] != state['source_commit']:
                    raise ValueError('Notification branch differs from this incident')
            state['branch_created'] = True
            self._store(state)
        existing = self.api('pulls?state=open&base=main&head=brogeun:' + state['branch'])
        if existing:
            if len(existing) != 1:
                raise ValueError('Ambiguous login notification')
            pull = existing[0]
        else:
            pull = self.api('pulls', method='POST', payload={
                'title': PREFIX + ' 휴대폰 인증 필요', 'base': 'main',
                'head': state['branch'], 'draft': True, 'maintainer_can_modify': False,
                'body': ('TCGHUB KREAM collector is waiting for the owner to authenticate.\n\n'
                         'Notification only. Do not merge this draft. No price files or code are changed.\n\n'
                         'incident_id: ' + state['incident_id'] + '\n'
                         'phone_request_status: ' + phone_status + '\n'
                         'No phone number, password, verification code, cookies or session values are included.\n')})
        self._verify_pull(pull, state)
        state.update(pull_request=pull['number'], html_url=pull.get('html_url'))
        self._store(state)
        return state

    @staticmethod
    def _verify_pull(pull, state):
        if (not pull.get('title', '').startswith(PREFIX)
                or pull.get('head', {}).get('ref') != state['branch']
                or pull.get('base', {}).get('ref') != 'main'
                or ('incident_id: ' + state['incident_id']) not in (pull.get('body') or '')):
            raise ValueError('Unrelated pull request was not modified')

    def resolve(self):
        state = self._read()
        if not state or state.get('resolved'):
            return
        if state.get('pull_request'):
            endpoint = 'pulls/' + str(int(state['pull_request']))
            pull = self.api(endpoint)
            self._verify_pull(pull, state)
            if pull['state'] == 'open':
                self.api(endpoint, method='PATCH', payload={'state': 'closed'})
        state.update(resolved=True, resolved_at=datetime.now(timezone.utc).isoformat())
        self._store(state)
