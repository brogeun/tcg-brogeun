# Phone authentication recovery

kream_phone_login.py matches the owner-observed phone page, including its text
input and the 본인인증하기 button, and waits for fields after navigation.
It never reads stored authentication data. Existing code forms do not cause an
automatic duplicate request. Unknown submission outcomes receive a cooldown.

kream_recovery_control.py keeps the owner browser open and starts
kream_chat_bridge.AuthBridge while waiting for authentication. The bridge uses
a local Windows named pipe; its ACL permits only the original owner and the
local CodexSandboxOffline account. Remote pipe clients are rejected. Clients
check the actual pipe owner and server process before transmitting a code.

submit_kream_code.py --submit accepts a code only on stdin. Codes stay in
process/pipe memory and are not placed in GitHub, status files, or logs. Public
metadata binds each command to one live incident and one unexpired challenge.
Duplicate submissions, expired challenges, arbitrary commands, and more than
three code attempts are blocked. A pipe acknowledgement is not login proof:
normal full-history verification must pass before collection resumes.

Run these checks from the installed kream-local root:

    python -B -m unittest discover -s recovery -p test_kream_chat_bridge.py
    python -B -m unittest discover -s recovery -p test_kream_recovery_control.py
    python -B -m unittest discover -s recovery -p test_collection_diagnostics.py

The browser tests intercept every request and serve dummy forms in an isolated
headless Edge. They do not use the owner's profile, send real phone challenges,
or prove that live KREAM accepted a code. IPC tests use a temporary named pipe
owned by the test account, not the real collector.

The daily normal-owner launcher loads these updated modules on its next run.
An already-running process still has its old imports; no unsafe process
injection or owner impersonation is used to activate code.

The existing GitHub-event ChatGPT automation can notify the owner that login is
needed. Mobile push delivery, phone visibility of this local Work conversation,
and a PC execution connection from the phone conversation are separate
requirements. A cloud-only conversation without this PC connection cannot use
the local pipe. No cloud relay, public code inbox, or plaintext GitHub fallback
is implemented.
