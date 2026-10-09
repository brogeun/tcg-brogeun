"""Operator-owned PSA/BGS worker v2. No paid API or challenge bypass."""
import argparse
import importlib.util
import json
import logging
import math
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import socket
import subprocess
import urllib.request
import time
import tempfile
from urllib.parse import urlparse
from cert_worker_core import classify_psa, classify_bgs, result, validate_job, retry_after_seconds
from cert_worker_api import read_psa_api

STATE_DIR = Path(os.environ.get("CERT_WORKER_STATE_DIR") or (Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "TCGHub" / "CertWorker"))
POLL_SECONDS = 20
LOG = logging.getLogger("cert-worker")


def configure_logging():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LOG.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    for handler in (logging.StreamHandler(), RotatingFileHandler(STATE_DIR / "worker.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")):
        handler.setFormatter(fmt)
        LOG.addHandler(handler)


def acquire_lock():
    handle = (STATE_DIR / "worker.lock").open("a+b")
    handle.seek(0)
    if handle.read(1) == b"":
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, IOError):
        handle.close()
        return None
    return handle


def check():
    mode = os.environ.get("PSA_LOOKUP_MODE", "browser").strip().lower()
    data = {
        "python_supported": sys.version_info >= (3, 9),
        "requests_installed": importlib.util.find_spec("requests") is not None,
        "playwright_installed": importlib.util.find_spec("playwright") is not None,
        "worker_key_configured": bool(os.environ.get("PSA_WORKER_KEY")),
        "site_https": urlparse(os.environ.get("SITE", "https://tcghub.kr")).scheme == "https",
        "state_directory": str(STATE_DIR),
        "mode": mode,
        "psa_api_token_configured": bool(os.environ.get("PSA_API_TOKEN", "").strip()),
        "human_challenge_dependency": mode == "browser",
    }
    print(json.dumps(data, ensure_ascii=False, indent=2))
    required = ["python_supported", "requests_installed", "worker_key_configured", "site_https"]
    required.append("psa_api_token_configured" if mode == "api" else "playwright_installed")
    return 0 if mode in ("api", "browser") and all(data[k] for k in required) else 2


class ChromeReader:
    def __init__(self):
        self.playwright = self.browser = self.context = self.page = self.process = None

    def open(self):
        from playwright.sync_api import sync_playwright
        if self.context and self.page and not self.page.is_closed():
            return
        self.close()
        candidates = [
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        ]
        executable = next((path for path in candidates if path.is_file()), None)
        if executable is None:
            raise RuntimeError("system_chrome_not_found")
        profile = STATE_DIR / "chrome-profile"
        profile.mkdir(parents=True, exist_ok=True)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        endpoint = f"http://127.0.0.1:{port}"
        # Start regular installed Chrome, then attach to its localhost-only interface.
        # This dedicated profile never reads the operator's personal Chrome data.
        arguments = [str(executable), f"--user-data-dir={profile}",
                     f"--remote-debugging-port={port}", "--remote-debugging-address=127.0.0.1",
                     "--no-first-run", "--no-default-browser-check", "--start-minimized",
                     "--new-window", "about:blank"]
        startup = None
        if os.name == "nt":
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 7  # SW_SHOWMINNOACTIVE; do not interrupt the operator.
        try:
            self.process = subprocess.Popen(arguments, stdout=subprocess.DEVNULL,
                                            stderr=subprocess.DEVNULL, startupinfo=startup)
            deadline = time.monotonic() + 15
            while True:
                try:
                    with urllib.request.urlopen(endpoint + "/json/version", timeout=1):
                        break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("chrome_startup_timeout")
                    time.sleep(0.2)
            self.playwright = sync_playwright().start()
            self.browser = self.playwright.chromium.connect_over_cdp(endpoint, timeout=10000)
            self.context = self.browser.contexts[0]
            self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            self.page.set_default_timeout(3000)
        except Exception:
            self.close()
            raise

    def read(self, job):
        self.open()
        page = self.page
        cert = job["cert_number"]
        document = {"status": 0, "retry_after": 0, "revision": 0}

        def observe_response(response):
            # Asset/API errors must not replace the status of the main document.
            if response.request.is_navigation_request() and response.frame == page.main_frame:
                document.update(status=response.status,
                                retry_after=retry_after_seconds(response.headers.get("retry-after", "")),
                                revision=document["revision"] + 1)

        def navigation_changed(error):
            message = str(error).lower()
            return any(marker in message for marker in (
                "execution context was destroyed", "cannot find context with specified id",
                "interrupted by another navigation", "net::err_aborted"))

        def finish(answer):
            if document["retry_after"] and answer["outcome"] != "success":
                answer["retry_after_seconds"] = max(document["retry_after"], answer.get("retry_after_seconds", 0))
            return answer

        def pause():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            page.wait_for_timeout(min(1000, max(1, int(remaining * 1000))))
            return True

        page.on("response", observe_response)
        try:
            try:
                response = page.goto("https://www.psacard.com/cert/" + cert, wait_until="domcontentloaded", timeout=30000)
                if response and not document["revision"]:
                    observe_response(response)
            except Exception as error:
                if not navigation_changed(error):
                    raise
            deadline = time.monotonic() + 30
            while True:
                source_url = page.url
                source = urlparse(source_url)
                if source.scheme != "https" or source.hostname not in ("www.psacard.com", "psacard.com"):
                    return finish(result("blocked", "unexpected_redirect", retry_after_seconds=1800))
                if document["status"] in (401, 429):
                    return finish(result("blocked", "source_access_restricted", retry_after_seconds=1800))
                revision = document["revision"]
                try:
                    title = page.title()
                    body_text = page.locator("body").inner_text(timeout=3000)
                    main = page.locator("main")
                    main_text = main.inner_text(timeout=3000) if main.count() else body_text
                    if page.url != source_url or document["revision"] != revision:
                        if pause():
                            continue
                        return finish(result("temporary_error", "browser_navigation_error", retry_after_seconds=300))
                except Exception as error:
                    if not navigation_changed(error):
                        raise
                    if pause():
                        continue
                    return finish(result("temporary_error", "browser_navigation_error", retry_after_seconds=300))
                lower = (title + "\n" + body_text).lower()
                hard_block = any(marker in lower for marker in (
                    "verify you are human", "access denied", "attention required", "captcha"))
                hard_block = hard_block or ("security verification" in lower and "performing security verification" not in lower)
                if hard_block:
                    return finish(result("blocked", "source_access_restricted", retry_after_seconds=1800))
                answer = classify_psa(main_text, cert, source_url, document["status"], title)
                loading = any(marker in lower for marker in (
                    "checking your browser", "just a moment", "performing security verification",
                    "verifying you are human", "잠시만 기다리십시오", "보안 확인 수행 중"))
                # Let ordinary document transitions finish; do not solve challenges,
                # reload blocked pages, or restart the browser to evade a denial.
                if loading and document["status"] < 500:
                    if pause():
                        continue
                    return finish(answer)
                if answer["outcome"] == "success":
                    record = answer["record"]
                    if (record.get("pop_total") is None or record.get("pop_higher") is None) and pause():
                        continue
                    return answer
                if answer["outcome"] in ("blocked", "not_found", "temporary_error") or not pause():
                    return finish(answer)
        finally:
            page.remove_listener("response", observe_response)

    def close(self):
        if self.browser:
            try:
                self.browser.new_browser_cdp_session().send("Browser.close")
            except Exception:
                pass
            try:
                self.browser.close()
            except Exception:
                pass
        if self.playwright:
            try:
                self.playwright.stop()
            except Exception:
                pass
        if self.process and self.process.poll() is None:
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=5)
        self.playwright = self.browser = self.context = self.page = self.process = None


def read_bgs(session, job):
    response = session.get("https://www.beckett.com/api/grading/lookup", params={"category": "BGS", "serialNumber": job["cert_number"]}, timeout=(5, 25))
    content_type = response.headers.get("Content-Type", "")
    payload = None
    if "json" in content_type.lower():
        try:
            payload = response.json()
        except ValueError:
            pass
    answer = classify_bgs(payload, job["cert_number"], response.url, response.status_code, content_type)
    retry_after = retry_after_seconds(response.headers.get("Retry-After", ""))
    if retry_after and answer["outcome"] != "success":
        answer["retry_after_seconds"] = max(retry_after, answer.get("retry_after_seconds", 0))
    return answer


def post_result(session, site, headers, job, outcome):
    payload = {"job_id": job["id"], "lease_token": job["lease_token"], "provider": job["provider"], "cert_number": job["cert_number"], **outcome}
    # Retry only acknowledgement, never repeat the external lookup here.
    for attempt in range(2):
        try:
            response = session.post(site + "/api/psa/cache", headers=headers, json=payload, timeout=(5, 15))
            if response.status_code in (401, 403):
                LOG.error("result_authentication_failed; check server/worker key")
                return "fatal"
            if response.status_code in (409, 410):
                LOG.warning("result_lease_expired; server will recover the job")
                return "expired"
            try:
                data = response.json()
            except ValueError:
                data = {}
            if response.ok and data.get("ok") is True:
                return "accepted"
            LOG.warning("result_rejected http=%s", response.status_code)
        except Exception:
            LOG.warning("result_network_error")
        if attempt == 0:
            time.sleep(3)
    return "failed"



def saved_psa_retry_deadline():
    from cert_worker_cooldown import latest_retry_deadline
    report_path = STATE_DIR / "unattended-api-validation.json"
    legacy_path = Path(__file__).resolve().parents[1] / "unattended-api-validation.json"
    return latest_retry_deadline(report_path, legacy_path)


def persist_psa_api_retry(seconds):
    """Atomically save only the rate-limit deadline; never credentials or card data."""
    seconds = max(1800, int(seconds))
    now = datetime.now(timezone.utc)
    existing = saved_psa_retry_deadline()
    if existing is not None:
        seconds = max(seconds, math.ceil((existing - now).total_seconds()))
    report = {"checked_at": now.isoformat(), "records": [{"response_details": {
        "status": 429, "headers": {"Retry-After": str(seconds)}}}]}
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    report_path = STATE_DIR / "unattended-api-validation.json"
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=STATE_DIR,
                                         prefix=".psa-cooldown-", suffix=".tmp", delete=False) as stream:
            temporary_path = stream.name
            stream.write(json.dumps(report, ensure_ascii=True))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, report_path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
    return seconds


def run():
    site = os.environ.get("SITE", "https://tcghub.kr").rstrip("/")
    key = os.environ.get("PSA_WORKER_KEY", "")
    if not key or urlparse(site).scheme != "https" or sys.version_info < (3, 9):
        print("설정 필요: Python 3.9+, HTTPS SITE, PSA_WORKER_KEY. --check 로 점검하세요.")
        return 2
    mode = os.environ.get("PSA_LOOKUP_MODE", "browser").strip().lower()
    psa_token = os.environ.get("PSA_API_TOKEN", "").strip()
    if mode not in ("api", "browser") or (mode == "api" and not psa_token):
        print("PSA API mode requires PSA_API_TOKEN. No lookup jobs were claimed.")
        return 2
    class BrowserError(Exception):
        pass
    try:
        import requests
        if mode == "browser":
            from playwright.sync_api import Error as BrowserError
    except ImportError:
        print("Dependencies required: requests; browser mode also requires playwright.")
        return 2
    retry_at = None
    if mode == "api":
        try:
            retry_at = saved_psa_retry_deadline()
        except (OSError, UnicodeError, ValueError, TypeError, OverflowError):
            print("Saved PSA API retry information is invalid. No lookup jobs or external requests were started.")
            return 2
    configure_logging()
    lock = acquire_lock()
    if lock is None:
        LOG.info("another_worker_is_running; exiting")
        return 0
    headers = {"x-psa-worker-key": key}
    api = requests.Session()
    source = requests.Session()  # Never forward the worker key to grading sites.
    chrome = ChromeReader() if mode == "browser" else None
    psa_source = requests.Session() if mode == "api" else None
    pause_until = {}
    if retry_at is not None:
        remaining = max(0, retry_at.timestamp() - time.time())
        if remaining > 0:
            pause_until["psa"] = time.monotonic() + remaining
            LOG.info("psa_api_saved_retry_after_active; first PSA lookup deferred")
    error_streak = 0
    LOG.info("worker_v2_started psa_mode=%s; no credentials or source bodies logged", mode)
    try:
        while True:
            try:
                response = api.post(site + "/api/psa/queue", headers=headers, json={"worker_version": 2}, timeout=(5, 15))
                if response.status_code in (401, 403):
                    LOG.error("queue_authentication_failed; worker stopped")
                    return 2
                if response.status_code in (404, 405, 426):
                    LOG.error("server_v2_not_deployed; worker stopped")
                    return 2
                response.raise_for_status()
                data = response.json()
                if data.get("ok") is not True or not isinstance(data.get("jobs"), list):
                    raise ValueError("queue_schema")
                jobs = data["jobs"]
                if len(jobs) > 1:
                    LOG.error("unexpected_batch_size; server must lease at most one job")
                    time.sleep(POLL_SECONDS)
                    continue
                error_streak = 0
            except (requests.RequestException, ValueError):
                error_streak += 1
                wait = min(300, POLL_SECONDS * (2 ** min(error_streak, 4)))
                LOG.warning("queue_unavailable; retry_in=%ss", wait)
                time.sleep(wait)
                continue
            if not jobs:
                try:
                    wait = min(300, max(10, int(data.get("retry_after_seconds", POLL_SECONDS))))
                except (TypeError, ValueError):
                    wait = POLL_SECONDS
                time.sleep(wait)
                continue
            job = jobs[0]
            if not validate_job(job):
                LOG.error("invalid_job_contract; refusing untrusted lookup URL")
                time.sleep(POLL_SECONDS)
                continue
            provider = job["provider"]
            cooldown_invalid = False
            if provider == "psa" and mode == "api":
                try:
                    # Another verifier may have saved a longer official wait since startup.
                    latest_retry_at = saved_psa_retry_deadline()
                    if latest_retry_at is not None:
                        remaining = max(0, latest_retry_at.timestamp() - time.time())
                        if remaining > 0:
                            pause_until[provider] = max(pause_until.get(provider, 0), time.monotonic() + remaining)
                except (OSError, UnicodeError, ValueError, TypeError, OverflowError):
                    LOG.error("psa_api_saved_retry_information_invalid; worker will stop without source lookup")
                    cooldown_invalid = True
            if cooldown_invalid:
                outcome = result("temporary_error", "psa_api_retry_information_invalid", retry_after_seconds=300)
            elif pause_until.get(provider, 0) > time.monotonic():
                outcome = result("blocked", "provider_cooldown", retry_after_seconds=int(pause_until[provider] - time.monotonic()) + 1)
            else:
                try:
                    if provider == "psa":
                        outcome = read_psa_api(psa_source, job, psa_token) if mode == "api" else chrome.read(job)
                    else:
                        outcome = read_bgs(source, job)
                except requests.RequestException:
                    outcome = result("temporary_error", "source_network_error", retry_after_seconds=300)
                except BrowserError:
                    if chrome:
                        chrome.close()  # Actual browser error only.
                    outcome = result("temporary_error", "browser_navigation_error", retry_after_seconds=300)
                except Exception:
                    outcome = result("temporary_error", "worker_internal_error", retry_after_seconds=300)
            persistence_failed = False
            if outcome["outcome"] == "blocked" and outcome.get("error_code") != "provider_cooldown":
                delay = max(1800, outcome.get("retry_after_seconds", 0))
                if provider == "psa" and mode == "api" and outcome.get("error_code") == "psa_api_rate_limited":
                    try:
                        delay = persist_psa_api_retry(delay)
                        outcome["retry_after_seconds"] = delay
                    except (OSError, UnicodeError, ValueError, TypeError, OverflowError):
                        LOG.error("psa_api_retry_persistence_failed; worker will stop")
                        persistence_failed = True
                pause_until[provider] = max(pause_until.get(provider, 0), time.monotonic() + delay)
            ack = post_result(api, site, headers, job, outcome)
            LOG.info("job_result provider=%s cert_suffix=%s outcome=%s error=%s ack=%s", provider, job["cert_number"][-4:], outcome["outcome"], outcome.get("error_code", "none"), ack)
            if ack == "fatal" or persistence_failed or cooldown_invalid:
                return 2
            if outcome.get("error_code") in ("psa_api_token_missing", "psa_api_authentication_required", "psa_api_access_denied"):
                LOG.error("psa_api_access_required; worker stopped without browser fallback")
                return 2
            time.sleep(5)
    except KeyboardInterrupt:
        LOG.info("worker_stopped_by_operator")
        return 0
    finally:
        if chrome:
            chrome.close()
        if psa_source:
            psa_source.close()
        api.close()
        source.close()
        lock.close()


def main():
    parser = argparse.ArgumentParser(description="TCG Hub PC certificate worker")
    parser.add_argument("--check", action="store_true", help="Configuration booleans, no network or secrets")
    parser.add_argument("--self-test", action="store_true", help="Pure fixture tests, no network")
    args = parser.parse_args()
    if args.check:
        return check()
    if args.self_test:
        import unittest
        suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern="cert_worker*_test.py")
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    return run()
