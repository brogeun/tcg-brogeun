"""Local, owner-bound IPC for a code supplied by the owner in ChatGPT.

Only status metadata is written to disk. Codes travel in a local Windows named
pipe, stay in memory, and are never sent through GitHub or an HTTP endpoint.
The collector remains the original normal Windows user.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import time
import uuid

OWNER_ACCOUNT = 'pc'
AUTH_FORM_VERSION = 2
PREFIX = '\\\\.\\pipe\\TCGHUB.KreamAuth.'
MAX_MESSAGE = 1024
CLIENT_ACCESS = 0x00120183  # read/write, attributes, READ_CONTROL; no create-instance
ID = re.compile(r'[0-9a-f]{32}')
STATES = frozenset(('request_not_confirmed', 'awaiting_code', 'code_received',
    'code_submitted', 'code_rejected', 'code_input_not_found',
    'code_entered_waiting_for_confirmation', 'owner_action_required',
    'code_destination_not_ready', 'challenge_expired', 'authenticated', 'closed'))


class BridgeError(Exception):
    """Arguments contain only a fixed, non-sensitive error code."""


@dataclass(repr=False)
class Command:
    action: str
    request_id: str
    code: str = field(default='', repr=False)

    def __repr__(self):
        return 'Command(action=%r, request_id=%r)' % (self.action, self.request_id)


def _windows():
    if os.name != 'nt':
        raise BridgeError('windows_required')
    import pywintypes
    import win32api
    import win32con
    import win32file
    import win32pipe
    import win32security
    return pywintypes, win32api, win32con, win32file, win32pipe, win32security


def current_sid():
    _, api, con, _, _, security = _windows()
    token = security.OpenProcessToken(api.GetCurrentProcess(), con.TOKEN_QUERY)
    try:
        sid = security.GetTokenInformation(token, security.TokenUser)[0]
        return security.ConvertSidToStringSid(sid)
    finally:
        token.Close()


def original_owner_sid():
    """Resolve the explicit original local account independently of IPC metadata."""
    _, api, _, _, _, security = _windows()
    sid = security.LookupAccountName(None, api.GetComputerName() + '\\' + OWNER_ACCOUNT)[0]
    return security.ConvertSidToStringSid(sid)


def _atomic(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.pending')
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n',
                             encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class AuthBridge:
    def __init__(self, root, *, owner_sid=None, client_sid=None, clock=time.time):
        types, _, _, files, pipes, security = _windows()
        if owner_sid is None:
            owner_sid = original_owner_sid()
        if current_sid() != owner_sid:
            raise BridgeError('original_owner_required')
        if security.CheckTokenMembership(None, security.CreateWellKnownSid(
                security.WinBuiltinAdministratorsSid, None)):
            raise BridgeError('normal_user_required')
        if client_sid is None:
            sid = security.LookupAccountName(None, 'CodexSandboxOffline')[0]
            client_sid = security.ConvertSidToStringSid(sid)
        if not re.fullmatch(r'S-1-(?:[0-9]+-)*[0-9]+', client_sid):
            raise BridgeError('invalid_client_identity')
        self.files, self.pipes = files, pipes
        self.pipe_error = types.error
        self.clock = clock
        self.path = Path(root) / 'recovery' / 'auth-bridge.json'
        self.incident = uuid.uuid4().hex
        self.challenge = uuid.uuid4().hex
        self.owner_sid = owner_sid
        self.name = PREFIX + self.incident
        self.deadline = self.clock() + 300
        self.connected = False
        self.response_sent = False
        self.connection_deadline = 0
        self.seen = set()
        self.attempts = 0
        self.state = 'request_not_confirmed'
        self.last_request_id = None
        attributes = types.SECURITY_ATTRIBUTES()
        attributes.SECURITY_DESCRIPTOR = security.ConvertStringSecurityDescriptorToSecurityDescriptor(
            'O:' + owner_sid + 'D:P(A;;GA;;;' + owner_sid + ')(A;;0x00120183;;;' +
            client_sid + ')', security.SDDL_REVISION_1)
        self.handle = pipes.CreateNamedPipe(self.name,
            pipes.PIPE_ACCESS_DUPLEX | 0x00080000,  # FILE_FLAG_FIRST_PIPE_INSTANCE
            pipes.PIPE_TYPE_MESSAGE | pipes.PIPE_READMODE_MESSAGE | pipes.PIPE_NOWAIT |
            pipes.PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, attributes)
        self._save()

    def snapshot(self):
        return {'schemaVersion': 1, 'auth_form_version': AUTH_FORM_VERSION,
                'incident_id': self.incident,
                'challenge_id': self.challenge, 'pipe_name': self.name,
                'owner_sid': self.owner_sid, 'server_pid': os.getpid(),
                'state': self.state, 'attempts': self.attempts,
                'last_request_id': self.last_request_id,
                'expires_at': datetime.fromtimestamp(self.deadline, timezone.utc).isoformat(),
                'updated_at': datetime.now(timezone.utc).isoformat(),
                'stores_verification_code': False}

    def _save(self):
        _atomic(self.path, self.snapshot())

    def set_state(self, state, *, new_challenge=False):
        if state not in STATES:
            state = 'owner_action_required'
        if new_challenge:
            self.challenge = uuid.uuid4().hex
            self.deadline = self.clock() + 300
            self.attempts = 0
            self.seen.clear()
            self.last_request_id = None
        self.state = state
        self._save()

    def _disconnect(self):
        try:
            self.pipes.DisconnectNamedPipe(self.handle)
        except Exception:
            pass
        self.connected = self.response_sent = False

    def _command(self, data):
        try:
            packet = json.loads(data)
        except (ValueError, UnicodeError):
            return None, 'invalid_message'
        if not isinstance(packet, dict) or not set(packet).issubset(
                {'action', 'incident_id', 'challenge_id', 'request_id', 'code'}):
            return None, 'invalid_message'
        if (packet.get('incident_id') != self.incident or
                packet.get('challenge_id') != self.challenge):
            return None, 'different_login_request'
        request_id = packet.get('request_id', '')
        if not isinstance(request_id, str) or not ID.fullmatch(request_id):
            return None, 'invalid_message'
        action = packet.get('action')
        if action == 'status' and 'code' not in packet:
            return None, 'status'
        if action == 'resend' and 'code' not in packet:
            return Command(action, request_id), 'accepted'
        if action != 'submit_code' or not isinstance(packet.get('code'), str):
            return None, 'invalid_message'
        if not re.fullmatch(r'[0-9]{4,8}', packet['code']):
            return None, 'invalid_code_format'
        if self.clock() >= self.deadline:
            self.set_state('challenge_expired')
            return None, 'challenge_expired'
        if request_id in self.seen:
            return None, 'already_received'
        if self.state not in ('awaiting_code', 'code_rejected'):
            return None, 'code_destination_not_ready'
        if self.attempts >= 3:
            return None, 'attempt_limit_reached'
        self.seen.add(request_id)
        self.last_request_id = request_id
        self.attempts += 1
        self.set_state('code_received')
        return Command(action, request_id, packet['code']), 'accepted'

    def poll(self):
        """One bounded, nonblocking poll from the collector's browser thread."""
        if self.handle is None:
            return None
        if self.state in ('awaiting_code', 'code_rejected') and self.clock() >= self.deadline:
            self.set_state('challenge_expired')
        if self.connected and self.clock() > self.connection_deadline:
            self._disconnect()
        if not self.connected:
            try:
                self.pipes.ConnectNamedPipe(self.handle, None)
            except self.pipe_error as error:
                if error.winerror == 536:  # waiting for a client
                    return None
                if error.winerror != 535:  # client already connected
                    self._disconnect()
                    return None
            self.connected = True
            self.connection_deadline = self.clock() + 3
        if self.response_sent:
            # Keep the reply buffered until the client reads and closes.
            try:
                self.pipes.PeekNamedPipe(self.handle, 0)
            except self.pipe_error:
                self._disconnect()
            return None
        try:
            _, data = self.files.ReadFile(self.handle, MAX_MESSAGE + 1)
        except self.pipe_error as error:
            if error.winerror != 232:  # nonblocking read with no data yet
                self._disconnect()
            return None
        if not data:
            return None
        command, result = self._command(data) if len(data) <= MAX_MESSAGE else (None, 'message_too_large')
        reply = {'result': result, 'state': self.state,
                 'request_id': command.request_id if command else self.last_request_id}
        try:
            self.files.WriteFile(self.handle, json.dumps(reply, separators=(',', ':')).encode('ascii'))
            self.response_sent = True
        except self.pipe_error:
            self._disconnect()
        return command

    def close(self):
        if self.handle is not None:
            self._disconnect()
            self.handle.Close()
            self.handle = None
            if self.state != 'authenticated':
                self.state = 'closed'
            self._save()


def send(root, action, *, code=None, owner_sid=None, timeout=8):
    """The caller supplies a code via stdin; nothing confidential is persisted."""
    types, _, _, files, pipes, security = _windows()
    if owner_sid is None:
        owner_sid = original_owner_sid()
    path = Path(root) / 'recovery' / 'auth-bridge.json'
    try:
        record = json.loads(path.read_bytes())
    except (OSError, ValueError):
        raise BridgeError('owner_bridge_not_running') from None
    incident, challenge = record.get('incident_id', ''), record.get('challenge_id', '')
    if (record.get('schemaVersion') != 1 or record.get('owner_sid') != owner_sid or
            not isinstance(incident, str) or not ID.fullmatch(incident) or
            not isinstance(challenge, str) or not ID.fullmatch(challenge) or
            record.get('pipe_name') != PREFIX + incident):
        raise BridgeError('invalid_bridge_metadata')
    if record.get('state') in ('closed', 'authenticated'):
        raise BridgeError('owner_bridge_not_waiting')
    if record.get('auth_form_version') != AUTH_FORM_VERSION:
        raise BridgeError('owner_bridge_update_required')
    if action not in ('status', 'submit_code', 'resend'):
        raise BridgeError('invalid_action')
    if action == 'submit_code' and (not isinstance(code, str) or not re.fullmatch(r'[0-9]{4,8}', code)):
        raise BridgeError('invalid_code_format')
    packet = {'action': action, 'incident_id': incident, 'challenge_id': challenge,
              'request_id': uuid.uuid4().hex}
    if action == 'submit_code':
        packet['code'] = code
    deadline = time.monotonic() + timeout
    handle = None
    try:
        while handle is None:
            try:
                handle = files.CreateFile(record['pipe_name'], CLIENT_ACCESS, 0, None,
                    files.OPEN_EXISTING, 0x00100000 | 0x00010000, None)
                # SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION
            except types.error as error:
                if error.winerror not in (2, 231) or time.monotonic() >= deadline:
                    raise BridgeError('owner_bridge_unavailable') from None
                time.sleep(0.05)
        descriptor = security.GetSecurityInfo(handle, security.SE_KERNEL_OBJECT,
                                              security.OWNER_SECURITY_INFORMATION)
        actual_owner = security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner())
        if (actual_owner != owner_sid or
                pipes.GetNamedPipeServerProcessId(handle) != record.get('server_pid')):
            raise BridgeError('owner_bridge_identity_mismatch')
        pipes.SetNamedPipeHandleState(handle, pipes.PIPE_READMODE_MESSAGE | pipes.PIPE_NOWAIT,
                                       None, None)
        files.WriteFile(handle, json.dumps(packet, separators=(',', ':')).encode('ascii'))
        while time.monotonic() < deadline:
            try:
                _, response = files.ReadFile(handle, MAX_MESSAGE)
                if response:
                    reply = json.loads(response)
                    return {k: reply[k] for k in ('result', 'state', 'request_id') if k in reply}
            except types.error as error:
                if error.winerror not in (232, 536):
                    raise BridgeError('delivery_outcome_unknown') from None
            time.sleep(0.05)
        raise BridgeError('delivery_outcome_unknown')
    except BridgeError:
        raise
    except Exception:
        raise BridgeError('bridge_request_failed') from None
    finally:
        if handle is not None:
            handle.Close()
