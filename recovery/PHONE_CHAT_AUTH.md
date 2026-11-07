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

The current native execution tool closes non-TTY stdin. Keep the no-TTY rule:
the agent can spawn the existing Python client through the Node runtime with
three ordinary pipes and call child.stdin.end. No secret belongs in the process
arguments or any shell script. This transport has reached the real owner
bridge; KREAM field recognition was the remaining live failure.

The field matcher supports a blank six-digit input, a unique unlabelled field
beside the phone input, separate one-digit boxes, and same-origin frames.
The owner screenshot confirms six boxes on /login/phone/verify and a 재발송
control. The regression checks cover six unlabelled boxes, first-box
autocomplete, link resend, and the 인증 완료 button.
Ambiguous candidates and foreign frames are rejected. On a future mismatch the
owner process records only type/length/boolean classifications, never values,
raw labels, identifiers, HTML, passwords, cookies or session data. These are
general supported layouts, not proof of the exact currently unseen KREAM DOM.

The bridge advertises auth_form_version=2. A client refuses an older running
owner process before transmitting any code; a fresh normal-owner run is needed
once to load this fix. This avoids asking for codes that old code cannot enter.

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
