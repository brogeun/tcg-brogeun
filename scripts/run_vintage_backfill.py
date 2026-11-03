"""Run a resumable PC artwork backfill and export verified files for review.

This launcher never signs in, pushes Git, or uploads data. The materializer keeps
each validated download in .backfill-cache; the result ZIP contains no code,
credentials, or catalogue snapshots that could overwrite concurrent edits.
"""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import urllib.error
import zipfile

import materialize_vintage_pokemon_release as target


RESULT_NAME = "TCGHUB_Vintage_Backfill_Result.zip"
REPORT_NAME = "TCGHUB_Vintage_Backfill_Status.json"
CACHE_NAME = ".backfill-cache"
LOG_NAME = "TCGHUB_Vintage_Backfill.log"


class BackfillAlreadyRunning(RuntimeError):
    pass


@contextlib.contextmanager
def exclusive_run_lock(root):
    """An OS-held lock is released even if the console/process is killed."""
    cache = target.safe_path(root, CACHE_NAME)
    cache.mkdir(exist_ok=True)
    path = target.safe_path(root, CACHE_NAME + "/runner.lock")
    with path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise BackfillAlreadyRunning("Backfill execution lock is unavailable") from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class ConsoleTee:
    def __init__(self, console, log, lock):
        self.console, self.log, self.lock = console, log, lock

    def write(self, text):
        with self.lock:
            self.console.write(text)
            self.log.write(text)
            self.console.flush()
            self.log.flush()
        return len(text)

    def flush(self):
        with self.lock:
            self.console.flush()
            self.log.flush()

    def isatty(self):
        return self.console.isatty()


@contextlib.contextmanager
def persistent_console_log(root):
    path = target.safe_path(root, LOG_NAME)
    with path.open("a", encoding="utf-8", buffering=1) as log:
        lock = threading.RLock()
        log.write("\n=== " + datetime.now().astimezone().isoformat(timespec="seconds") + " ===\n")
        with contextlib.redirect_stdout(ConsoleTee(sys.stdout, log, lock)):
            with contextlib.redirect_stderr(ConsoleTee(sys.stderr, log, lock)):
                yield


def sanitized_failures(error):
    """Retain useful source identity without copying URLs or exception text."""
    failures = getattr(error, "failures", None)
    if not isinstance(failures, list):
        return []
    cleaned = []
    patterns = {
        "host": r"[a-z0-9.-]{1,253}",
        "setCode": r"[A-Za-z0-9+_-]{1,80}",
        "sourceId": r"[A-Za-z0-9_-]{1,100}",
        "kind": r"[A-Za-z0-9_-]{1,80}",
    }
    for row in failures:
        if not isinstance(row, dict):
            continue
        result = {}
        for key, pattern in patterns.items():
            value = row.get(key)
            if isinstance(value, str) and re.fullmatch(pattern, value):
                result[key] = value
        code = row.get("httpCode")
        if type(code) is int and 100 <= code <= 599:
            result["httpCode"] = code
        if result:
            cleaned.append(result)
    return cleaned


def atomic_write(path, body):
    """Keep the previous complete report if writing its replacement fails."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".backfill-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(body)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def export_result(root, outcome, error=None):
    """Package only independently revalidated image bytes and their review."""
    root = Path(root).resolve()
    review_path = target.safe_path(root, target.REVIEW)
    review_body = review_path.read_bytes()
    review = target.load_review(root)
    if review_path.read_bytes() != review_body:
        raise ValueError("Source review changed while preparing the result")
    target.safe_path(root, CACHE_NAME)
    archive = target.safe_path(root, RESULT_NAME)
    report_path = target.safe_path(root, REPORT_NAME)
    assets, missing, invalid = [], [], []
    for row in review["images"]:
        identity = {"setCode": row["setCode"], "sourceId": row["sourceId"]}
        # A completed generation may already have local files. Never infer their
        # validity from presence alone: every exported byte is checked again.
        candidates = [target.safe_path(root, CACHE_NAME + "/" + row["sha256"]),
                      target.safe_path(root, row["localImage"][1:])]
        body = None
        for path in candidates:
            if not path.is_file():
                continue
            try:
                if path.stat().st_size > target.MAX_IMAGE_BYTES:
                    raise ValueError("Oversized cached artwork")
                body = target.image_bytes(path.read_bytes(), row)
                break
            except (OSError, ValueError) as failure:
                invalid.append({**identity, "errorType": type(failure).__name__})
        if body is None:
            missing.append(identity)
        else:
            assets.append((row["localImage"][1:], path, row))

    status = outcome
    if outcome == "complete" and (missing or invalid):
        status = "failed"
    report = {
        "schemaVersion": 1,
        "status": status,
        "required": len(review["images"]),
        "verified": len(assets),
        "remaining": len(missing),
        "missing": missing,
        "invalidAssets": invalid,
        "reviewSHA256": hashlib.sha256(review_body).hexdigest(),
        "cacheDirectory": CACHE_NAME,
        "resumeCommand": "TCGHUB_Vintage_Backfill.cmd",
        "publicationPerformed": False,
        "catalogueSnapshotsIncluded": False,
    }
    if error is not None:
        # Exception text may contain URLs or local/account information. Only
        # structured type/status metadata belongs in a user-shareable archive.
        report["errorType"] = type(error).__name__
        if isinstance(error, urllib.error.HTTPError):
            report["httpStatus"] = error.code
        failures = getattr(error, "failures", None)
        if isinstance(failures, list):
            report["sourceFailureCount"] = len(failures)
            report["sourceFailures"] = sanitized_failures(error)
    report_body = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, prefix=".backfill-result-", suffix=".zip", delete=False) as stream:
            temporary = Path(stream.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
            output.writestr(target.REVIEW, review_body)
            output.writestr(REPORT_NAME, report_body)
            for name, path, row in assets:
                # Recheck at archive time too; keep memory bounded to one image.
                if path.stat().st_size > target.MAX_IMAGE_BYTES:
                    raise ValueError("Oversized cached artwork")
                output.writestr(name, target.image_bytes(path.read_bytes(), row))
        with zipfile.ZipFile(temporary) as output:
            if output.testzip() is not None:
                raise ValueError("Result archive verification failed")
        atomic_write(report_path, report_body)
        os.replace(temporary, archive)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return report, archive


def run_backfill(root, workers=2):
    root = Path(root).resolve()
    try:
        with exclusive_run_lock(root):
            with persistent_console_log(root):
                try:
                    return _run_backfill(root, workers)
                except Exception as error:
                    print("결과 파일을 만들지 못했습니다. 오류 종류: " + type(error).__name__, flush=True)
                    print(".backfill-cache 폴더를 지우지 말고 현재 메시지를 알려주세요.", flush=True)
                    return 1
    except BackfillAlreadyRunning:
        print("이미 실행 중인 창이 있거나 실행 잠금을 얻지 못했습니다. 기존 창을 확인해주세요.", flush=True)
        return 3


def _run_backfill(root, workers):
    outcome, failure = "complete", None
    print("TCGHUB 구형 카드 이미지 이어받기를 시작합니다.", flush=True)
    print("완료한 파일은 보존됩니다. 중단 후 같은 CMD를 다시 실행하면 이어받습니다.", flush=True)
    try:
        target.run(root, workers=workers, cache_dir=target.safe_path(root, CACHE_NAME))
    except KeyboardInterrupt as error:
        outcome, failure = "interrupted", error
    except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
        outcome, failure = "partial", error
    except Exception as error:
        partial_type = getattr(target, "PartialDownloadError", None)
        outcome = "partial" if partial_type is not None and isinstance(error, partial_type) else "failed"
        failure = error
    report, archive = export_result(root, outcome, failure)
    print("검증 완료 {verified} / 전체 {required}, 남은 파일 {remaining}".format(**report), flush=True)
    print("결과 파일: " + str(archive), flush=True)
    print("이 ZIP을 대화에 첨부하면 기존 작업과 비교한 뒤 반영할 수 있습니다.", flush=True)
    for item in report.get("sourceFailures", []):
        print("확인 필요: " + json.dumps(item, ensure_ascii=False), flush=True)
    if report["status"] == "complete":
        print("이미지 받기를 완료했습니다. 사이트 반영은 아직 하지 않았습니다.", flush=True)
        return 0
    if report["status"] == "interrupted":
        print("사용자가 중단했습니다. 완료한 파일과 결과 ZIP을 보존했습니다.", flush=True)
        return 130
    if report["status"] == "partial":
        print("일부 출처의 요청이 중단되었습니다. 완료한 파일을 다시 받지 않습니다.", flush=True)
        print("403/429를 반복 요청하지 마세요. 결과 ZIP의 잔여 항목을 확인할 수 있습니다.", flush=True)
        return 2
    print("검증 또는 실행 오류가 있습니다. 완료한 안전한 파일만 결과 ZIP에 보존했습니다.", flush=True)
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=2)
    args = parser.parse_args()
    try:
        return run_backfill(args.root, args.workers)
    except Exception as error:
        print("결과 파일을 만들지 못했습니다. 오류 종류: " + type(error).__name__, flush=True)
        print(".backfill-cache 폴더를 지우지 말고 현재 메시지를 알려주세요.", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
