"""Portable result archives retain work without publishing catalogue snapshots."""
from __future__ import annotations

import contextlib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

from PIL import Image

import run_vintage_backfill as launcher


class BackfillLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="backfill-launcher-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.rows, self.bodies = [], {}
        for ident, color in (("29518", "#a5bac8"), ("29519", "#d8b4a0")):
            output = io.BytesIO()
            Image.new("RGB", (250, 350), color).save(output, format="WEBP")
            body = output.getvalue()
            row = {
                "setCode": "Neo1", "sourceId": ident,
                "sourceUrl": "https://www.tcgcollector.com/cards/" + ident + "/reviewed-card",
                "sourceName": "Reviewed card " + ident,
                "originalImage": "https://static.tcgcollector.com/content/images/11/22/33/" + "a" * 64 + ".jpg",
                "imageSourceUrl": "https://static.tcgcollector.com/content/images/11/22/33/" + "b" * 64 + ".webp",
                "localImage": "/images/pokemon-vintage/Neo1/tcg-" + ident + ".webp",
                "sha256": hashlib.sha256(body).hexdigest(), "width": 250, "height": 350,
                "bytes": len(body), "method": "exact-source-page-canonical-id-and-image-alt",
            }
            self.rows.append(row)
            self.bodies[ident] = body
        self.review = {"schemaVersion": 1, "images": self.rows, "errors": []}
        review_path = self.root / launcher.target.REVIEW
        review_path.parent.mkdir(parents=True)
        with gzip.open(review_path, "wt", encoding="utf-8") as stream:
            json.dump(self.review, stream)

    def cache(self, index):
        row = self.rows[index]
        path = self.root / launcher.CACHE_NAME / row["sha256"]
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(self.bodies[row["sourceId"]])
        return path

    def invoke(self, effect):
        # The runner must use the materializer's same persistent cache on every
        # invocation. Real download resumption is covered in core API tests.
        with patch.object(launcher.target, "run", side_effect=effect) as collect:
            with contextlib.redirect_stdout(io.StringIO()):
                result = launcher.run_backfill(self.root)
        self.assertEqual(collect.call_args.kwargs["cache_dir"], self.root / launcher.CACHE_NAME)
        self.assertEqual(collect.call_args.kwargs["workers"], 2)
        return result

    def read_result(self):
        archive = zipfile.ZipFile(self.root / launcher.RESULT_NAME)
        self.addCleanup(archive.close)
        report = json.loads(archive.read(launcher.REPORT_NAME))
        self.assertEqual(report, json.loads((self.root / launcher.REPORT_NAME).read_bytes()))
        self.assertIsNone(archive.testzip())
        return archive, report

    def test_partial_result_is_portable_and_second_run_keeps_existing_verified_image(self):
        first = self.cache(0)
        before = first.read_bytes()
        denial = urllib.error.HTTPError("https://cdn.pooka.app/private?secret=do-not-copy", 403, "forbidden", {}, None)
        self.assertEqual(self.invoke(denial), 2)
        archive, report = self.read_result()
        self.assertEqual(report["status"], "partial")
        self.assertEqual((report["verified"], report["remaining"]), (1, 1))
        self.assertEqual(report["httpStatus"], 403)
        self.assertNotIn(b"do-not-copy", archive.read(launcher.REPORT_NAME))
        expected = {launcher.target.REVIEW, launcher.REPORT_NAME, self.rows[0]["localImage"][1:]}
        self.assertEqual(set(archive.namelist()), expected)
        self.assertEqual(archive.read(self.rows[0]["localImage"][1:]), before)
        archive.close()

        def finish(root, **options):
            self.assertEqual(first.read_bytes(), before)
            self.cache(1)
            return {"status": "validated-local"}

        self.assertEqual(self.invoke(finish), 0)
        archive, report = self.read_result()
        self.assertEqual((report["status"], report["verified"], report["remaining"]), ("complete", 2, 0))
        self.assertEqual(first.read_bytes(), before)
        self.assertFalse(report["publicationPerformed"])
        self.assertFalse(report["catalogueSnapshotsIncluded"])
        self.assertTrue(all(not name.startswith("data/") and not name.endswith((".py", ".cmd", ".exe")) for name in archive.namelist()))

    def test_integrity_failure_is_reported_and_bad_bytes_never_enter_archive(self):
        broken = self.cache(0)
        broken.write_bytes(b"not the reviewed image")
        self.cache(1)
        archive_report, archive_path = launcher.export_result(self.root, "complete")
        self.assertEqual(archive_report["status"], "failed")
        self.assertEqual(len(archive_report["invalidAssets"]), 1)
        with zipfile.ZipFile(archive_path) as archive:
            self.assertNotIn(self.rows[0]["localImage"][1:], archive.namelist())
            self.assertIn(self.rows[1]["localImage"][1:], archive.namelist())
        self.assertEqual(broken.read_bytes(), b"not the reviewed image")

    def test_interrupt_exports_completed_work_and_has_distinct_exit_code(self):
        self.cache(0)
        self.assertEqual(self.invoke(KeyboardInterrupt()), 130)
        archive, report = self.read_result()
        self.assertEqual(report["status"], "interrupted")
        self.assertEqual(report["verified"], 1)
        self.assertEqual(report["remaining"], 1)

    def test_programming_or_identity_failure_cannot_masquerade_as_complete(self):
        self.cache(0)
        self.cache(1)
        self.assertEqual(self.invoke(ValueError("identity mismatch with secret contents")), 1)
        archive, report = self.read_result()
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["verified"], 2)
        self.assertEqual(report["errorType"], "ValueError")
        self.assertNotIn(b"secret contents", archive.read(launcher.REPORT_NAME))

    def test_completed_existing_local_images_are_revalidated_and_exported(self):
        for row in self.rows:
            path = self.root / row["localImage"][1:]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.bodies[row["sourceId"]])
        self.assertEqual(self.invoke(lambda *args, **kwargs: {}), 0)
        archive, report = self.read_result()
        self.assertEqual(report["verified"], 2)

    def test_unsafe_cache_link_does_not_replace_previous_result(self):
        previous = self.root / launcher.RESULT_NAME
        previous.write_bytes(b"previous complete result")
        outside = self.root / "outside"
        outside.mkdir()
        try:
            (self.root / launcher.CACHE_NAME).symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("This host cannot create test symlinks")
        with self.assertRaisesRegex(ValueError, "links|reparse"):
            launcher.export_result(self.root, "partial")
        self.assertEqual(previous.read_bytes(), b"previous complete result")

    def test_partial_source_failures_and_full_console_output_are_persisted_safely(self):
        class PartialDownloadError(RuntimeError):
            failures = [{"host": "cdn.pooka.app", "setCode": "DP1", "sourceId": "ja-dp1-108",
                         "kind": "HTTPError", "httpCode": 403,
                         "url": "https://private.invalid/?secret=do-not-copy"},
                        {"host": "https://private.invalid/secret", "httpCode": True}]

        self.cache(0)

        def collect(*args, **kwargs):
            print("progress output stays visible", flush=True)
            print("stderr diagnostic stays visible", file=sys.stderr, flush=True)
            raise PartialDownloadError("do-not-copy")

        with patch.object(launcher.target, "PartialDownloadError", PartialDownloadError, create=True):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(self.invoke(collect), 2)
        archive, report = self.read_result()
        self.assertEqual(report["sourceFailureCount"], 2)
        self.assertEqual(report["sourceFailures"], [{"host": "cdn.pooka.app", "setCode": "DP1",
                         "sourceId": "ja-dp1-108", "kind": "HTTPError", "httpCode": 403}])
        log = (self.root / launcher.LOG_NAME).read_text(encoding="utf-8")
        self.assertIn("progress output stays visible", log)
        self.assertIn("stderr diagnostic stays visible", log)
        self.assertIn("cdn.pooka.app", log)
        self.assertNotIn("do-not-copy", log)
        self.assertNotIn(b"do-not-copy", archive.read(launcher.REPORT_NAME))
        self.assertNotIn(launcher.LOG_NAME, archive.namelist())

    def test_double_click_cannot_overwrite_an_active_run_and_os_lock_releases(self):
        prior = self.root / launcher.RESULT_NAME
        prior.write_bytes(b"prior result")
        with launcher.exclusive_run_lock(self.root):
            with patch.object(launcher.target, "run") as collect:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(launcher.run_backfill(self.root), 3)
                collect.assert_not_called()
        self.assertEqual(prior.read_bytes(), b"prior result")
        for index in range(2):
            self.cache(index)
        self.assertEqual(self.invoke(lambda *args, **kwargs: {}), 0)

    @unittest.skipUnless(os.name == "nt", "Real CMD launcher is Windows-only")
    def test_actual_cmd_launcher_handles_spaces_and_korean_paths_without_network_or_git(self):
        from test_materialize_vintage_pokemon_release import Fixture

        portable = self.root / "TCG 백필 실행 폴더"
        portable.mkdir()
        fixture = Fixture(portable)
        cache = portable / launcher.CACHE_NAME
        cache.mkdir()
        (cache / fixture.row["sha256"]).write_bytes(fixture.body)
        scripts = portable / "scripts"
        scripts.mkdir()
        original = Path(__file__).resolve().parent
        for name in ("run_vintage_backfill.py", "materialize_vintage_pokemon_release.py", "publish_data_snapshot.py"):
            shutil.copyfile(original / name, scripts / name)
        shutil.copyfile(original.parent / "TCGHUB_Vintage_Backfill.cmd", portable / "TCGHUB_Vintage_Backfill.cmd")
        subprocess.run([sys.executable, "-m", "venv", "--system-site-packages", str(portable / ".backfill-venv")],
                       check=True, capture_output=True, timeout=90)
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        result = subprocess.run(["cmd.exe", "/d", "/c", "call", str(portable / "TCGHUB_Vintage_Backfill.cmd")],
                                cwd=portable, input="\n", text=True, encoding="utf-8", errors="replace",
                                capture_output=True, env=env, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with zipfile.ZipFile(portable / launcher.RESULT_NAME) as archive:
            report = json.loads(archive.read(launcher.REPORT_NAME))
            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["verified"], 1)
            self.assertEqual(archive.read(fixture.row["localImage"][1:]), fixture.body)
        self.assertTrue((portable / launcher.LOG_NAME).is_file())


if __name__ == "__main__":
    unittest.main()
