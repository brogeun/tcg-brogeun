"""Offline workflow contracts, including execution of its actual outcome functions."""
import ast
from datetime import datetime, timezone
from pathlib import Path
import re
import textwrap
import unittest


ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/market-references-daily.yml"
SOURCES = ("us", "yuyutei", "mercari", "snkrdunk")


def jobs(text):
    body = text.split("\njobs:\n", 1)[1]
    starts = list(re.finditer(r"(?m)^  ([a-z][a-z0-9_-]*):\s*$", body))
    return {match[1]: body[match.end():starts[index + 1].start() if index + 1 < len(starts) else len(body)]
            for index, match in enumerate(starts)}


def python_blocks(text):
    blocks = []
    for start in re.finditer(r"(?m)^([ \t]*)python - <<'PY'\s*$", text):
        end = re.search(r"(?m)^" + re.escape(start[1]) + r"PY\s*$", text[start.end():])
        if end is None:
            raise AssertionError("Unterminated workflow Python block")
        blocks.append(textwrap.dedent(text[start.end():start.end() + end.start()]).strip())
    return blocks


def embedded_function(job, function_name):
    for script in python_blocks(job):
        tree = ast.parse(script)
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == function_name:
                namespace = {"datetime": datetime, "timezone": timezone}
                exec(compile(ast.Module(body=[node], type_ignores=[]), "<workflow-function>", "exec"), namespace)
                return namespace[function_name]
    raise AssertionError("Missing workflow function: " + function_name)


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.jobs = jobs(cls.text)

    def test_schedule_dispatch_and_main_code_push_without_generated_data_loop(self):
        self.assertTrue(self.text.startswith("name: Market Reference Prices Daily\n"))
        self.assertIn("cron: '35 20 * * *'", self.text)
        self.assertIn("  workflow_dispatch:", self.text)
        trigger = self.text.split("\npermissions:", 1)[0]
        self.assertIn("branches: [main]", trigger)
        self.assertIn("'scripts/game_registry.py'", trigger)
        for script in ("collect_us_market.py", "collect_yuyutei_market.py", "collect_mercari_references.py", "collect_snkrdunk_games.py"):
            self.assertIn("'scripts/" + script + "'", trigger)
        for name in ("assets/tcg-card-info.js", "assets/card-price-fallback.js", "scripts/build_tcg_card_info.py", ".github/workflows/market-references-daily.yml"):
            self.assertNotIn("'" + name + "'", trigger)
        self.assertNotRegex(trigger, r"(?m)^\s+- ['\"]?data/")
        self.assertNotIn("workflow_run:", trigger)

    def test_queued_runs_and_parallel_collectors(self):
        self.assertIn("cancel-in-progress: false", self.text)
        self.assertIn("queue: max", self.text)
        self.assertIn("permissions:\n  contents: write", self.text)
        self.assertEqual(set(self.jobs), {"verify", "health", *SOURCES})
        for source in SOURCES:
            self.assertRegex(self.jobs[source], r"needs:\s*\[verify\]")
            for other in SOURCES:
                if source != other:
                    self.assertNotRegex(self.jobs[source], r"needs:.*\b" + other + r"\b")
        self.assertIn("needs: [verify, us, yuyutei, mercari, snkrdunk]", self.jobs["health"])
        self.assertIn("if: always() && needs.verify.result == 'success'", self.jobs["health"])

    def test_pinned_collection_commit_and_current_main_final_health(self):
        for source in SOURCES:
            body = self.jobs[source]
            self.assertIn("ref: ${{ github.sha }}", body)
            self.assertIn('test "$actual" = "$GITHUB_SHA"', body)
            self.assertIn('COLLECTION_COMMIT=$actual', body)
            self.assertIn("python-version: '3.11'", body)
            self.assertIn("fetch-depth: 0", body)
        self.assertIn("ref: main", self.jobs["health"])
        self.assertNotIn("ref: ${{ github.sha }}", self.jobs["health"])
        self.assertIn("COLLECTION_COMMIT=$actual", self.jobs["health"])

    def test_offline_verify_contracts_run_before_collection(self):
        commands = (
            "python -m unittest scripts.test_collect_us_market",
            "python -m unittest discover -s tests -p test_yuyutei_market.py",
            "python scripts/test_collect_mercari_references.py",
            "python -m unittest discover -s scripts -p test_snkrdunk_games.py",
            "python -m unittest scripts.test_metadata_index",
            "python -m unittest discover -s tests -p test_build_tcg_card_info.py",
            "python -m unittest discover -s scripts -p test_publish_data_snapshot.py",
            "python -m unittest discover -s scripts -p test_validate_reference_markets.py",
            "python -m unittest scripts.test_market_references_workflow",
            "node --test scripts/test_market_references.cjs",
            "node --test scripts/test_reference_integration.cjs",
            "node --test scripts/test_price_metadata_shards.cjs",
            "node --test scripts/test_tcg_card_info.cjs",
            "node --test scripts/test_card_price_fallback.cjs",
            "node --test scripts/test_contained_card_prices.cjs",
            "node --test scripts/test_card_info_pricing_integration.cjs",
        )
        for command in commands:
            self.assertIn(command, self.jobs["verify"])
        self.assertNotIn("continue-on-error:", self.jobs["verify"])

    def test_each_source_preserves_failure_outcome_then_validates_before_publishing(self):
        for source in SOURCES:
            body = self.jobs[source]
            self.assertEqual(body.count("continue-on-error: true"), 1)
            self.assertIn("STEP_OUTCOME: ${{ steps.collect.outcome }}", body)
            self.assertIn("collector_outcome: ${{ steps.assess.outputs.outcome }}", body)
            validation = "python scripts/validate_reference_markets.py --root . --output .cache/reference-check-" + source + ".json"
            publication = 'python scripts/publish_data_snapshot.py --references --base "$COLLECTION_COMMIT"'
            self.assertIn(validation, body)
            self.assertIn(publication, body)
            self.assertLess(body.index(validation), body.index(publication))
            self.assertNotIn("data/reference-market-health.json", body)
            # Integrity validation and publication must not inherit collector's
            # continue-on-error; their own steps use the normal failure policy.
            tail = body[body.index("- name: Validate "):]
            self.assertNotIn("continue-on-error:", tail)

    def test_step_ids_are_unique_inside_each_independent_source_job(self):
        for source in SOURCES:
            ids = re.findall(r"(?m)^        id:\s*([A-Za-z0-9_-]+)\s*$", self.jobs[source])
            self.assertEqual(len(ids), len(set(ids)), source)
            self.assertEqual(ids.count("collect"), 1)
            self.assertEqual(ids.count("assess"), 1)

    def test_compact_catalog_has_one_serialized_deployment_writer(self):
        body = self.jobs['snkrdunk']
        build = 'python scripts/build_tcg_card_info.py --root .'
        self.assertNotIn(build, body)
        self.assertIn(build, self.jobs['verify'])
        self.assertNotIn("steps.card_info", body)
        self.assertLess(body.index('python scripts/collect_snkrdunk_games.py'), body.index('python scripts/validate_reference_markets.py'))
        self.assertLess(body.index('python scripts/validate_reference_markets.py'), body.index('python scripts/publish_data_snapshot.py'))
        deploy = (Path(__file__).resolve().parents[1] / '.github/workflows/scrape.yml').read_text(encoding='utf-8')
        publish = 'python scripts/publish_data_snapshot.py --files data/tcg-card-info.json'
        self.assertLess(deploy.index(build), deploy.index(publish))
        self.assertLess(deploy.index(publish), deploy.index('--prepare-deploy'))
        self.assertIn('group: scrape', deploy)
        self.assertEqual(self.text.count(build + '\n'), 1)

    def test_source_cache_never_restores_tracked_market_data(self):
        self.assertIn("path: .cache/us-market", self.jobs["us"])
        for body in self.jobs.values():
            self.assertNotRegex(body, r"(?m)^\s+path:\s*data/")
            self.assertNotRegex(body, r"(?m)^\s+-\s*data/")
        self.assertNotIn("actions/cache", self.jobs["yuyutei"])
        self.assertNotIn("actions/cache", self.jobs["snkrdunk"])

    def test_source_budgets_allow_checkpoint_cleanup(self):
        self.assertIn("--max-sets-per-game 45 --max-requests 250 --workers 2 --requests-per-second 0.5 --resume-hours 20", self.jobs["yuyutei"])
        self.assertIn("--max-items 20 --timeout 20", self.jobs["mercari"])
        self.assertIn("--grade-limit=1500 --history-limit=500 --max-seconds=7200 --delay=0.25", self.jobs["snkrdunk"])
        self.assertEqual(re.findall(r"--grade-limit(?:=|\s+)(\d+)", self.jobs["snkrdunk"]), ["1500"])
        self.assertEqual(re.findall(r"--history-limit(?:=|\s+)(\d+)", self.jobs["snkrdunk"]), ["500"])
        self.assertIn("timeout-minutes: 125", self.jobs["snkrdunk"])
        self.assertIn("timeout-minutes: 145", self.jobs["snkrdunk"])
        self.assertIn("--brands=weiss_schwarz,union_arena,dragon_ball_fusion_world,yugioh,digimon", self.jobs["snkrdunk"])

    def test_final_health_outcomes_do_not_mask_publication_failure(self):
        for source in SOURCES:
            expected = "needs." + source + ".result == 'success' && needs." + source + ".outputs.collector_outcome || needs." + source + ".result"
            self.assertIn(expected, self.jobs["health"])
        self.assertIn("REFERENCE_SOURCE_OUTCOMES:", self.jobs["health"])
        self.assertIn("--output data/reference-market-health.json", self.jobs["health"])
        self.assertLess(self.jobs["health"].index("--message 'Refresh market reference health'"), self.jobs["health"].index("- name: Fail only when"))

    def test_existing_deploy_is_reused_without_duplicate_cloudflare_or_git_push(self):
        for text in ("wrangler", "CF_API_TOKEN", "CF_ACCOUNT_ID", "git push", "git rebase", "--force", "deploy_site"):
            self.assertNotIn(text, self.text)
        self.assertNotIn(".github/workflows/scrape.yml", self.text)

    def test_all_embedded_python_is_valid_syntax(self):
        blocks = python_blocks(self.text)
        self.assertEqual(len(blocks), 5)
        for script in blocks:
            ast.parse(script)


class ActualOutcomeFunctionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.jobs = jobs(WORKFLOW.read_text(encoding="utf-8"))

    def function(self, source):
        return embedded_function(self.jobs[source], "classify")

    def test_us_last_good_exit_zero_failure_is_not_reported_as_refresh_success(self):
        classify = self.function("us")
        self.assertEqual(classify("success", {"status": "failed-kept-previous"}), "failure")
        self.assertEqual(classify("failure", {"status": "complete-for-mapped-sets"}), "failure")
        self.assertEqual(classify("success", {"status": "partial-provider-failure", "coverage": {"mappedSets": 2}}), "partial")
        self.assertEqual(classify("success", {"status": "partial-provider-failure", "coverage": {"mappedSets": 0}}), "failure")
        self.assertEqual(classify("success", {"status": "unchanged"}), "success")

    def test_yuyutei_cooldown_is_deferred_and_failed_attempts_stay_failed(self):
        classify = self.function("yuyutei")
        self.assertEqual(classify("success", {"status": "partial", "cooldown": {"nextEligibleAt": "2099-01-01T00:00:00Z"}}), "deferred")
        all_failed = {"status": "partial", "requestsThisRun": 5, "games": [{"coverage": {"setsAttemptedThisRun": 5, "failedSets": 5, "recordsFetchedThisRun": 0}}]}
        self.assertEqual(classify("success", all_failed), "failure")
        partial = {"status": "partial", "requestsThisRun": 5, "games": [{"coverage": {"setsAttemptedThisRun": 5, "failedSets": 1, "recordsFetchedThisRun": 20}}]}
        self.assertEqual(classify("success", partial), "partial")
        self.assertEqual(classify("failure", partial), "failure")

    def test_yuyutei_reused_last_good_is_not_a_new_failure_from_old_failed_counts(self):
        classify = self.function("yuyutei")
        reused = {"status": "partial", "requestsThisRun": 0, "games": [{"coverage": {"setsAttemptedThisRun": 5, "failedSets": 5, "recordsFetchedThisRun": 0}}]}
        self.assertEqual(classify("success", reused), "partial")

    def test_mercari_candidates_are_refresh_success_without_becoming_verified_prices(self):
        classify = self.function("mercari")
        self.assertEqual(classify("success", {"coverage": {"fetchedCount": 20, "errorCount": 0, "verifiedQuoteCount": 0}}), "success")
        self.assertEqual(classify("success", {"coverage": {"fetchedCount": 1, "errorCount": 19}}), "partial")
        self.assertEqual(classify("success", {"coverage": {"fetchedCount": 0, "errorCount": 20}}), "failure")

    def test_snkrdunk_budget_checkpoint_is_partial_and_source_stop_is_failure(self):
        classify = self.function("snkrdunk")
        partial = {"collection": {"status": "checkpointed-partial"}}
        self.assertEqual(classify("success", partial), "partial")
        self.assertEqual(classify("failure", partial), "failure")
        self.assertEqual(classify("success", {"collection": {"status": "completed-requested-budgets", "gradeFailures": 1}}), "partial")
        self.assertEqual(classify("success", {"collection": {"status": "completed-requested-budgets"}}), "success")

    def test_partial_or_deferred_valid_data_never_creates_an_all_sources_failed_email(self):
        all_failed = embedded_function(self.jobs["health"], "all_collectors_failed")
        failed = {source: "failure" for source in SOURCES}
        self.assertTrue(all_failed(failed))
        for state in ("success", "partial", "deferred", "skipped"):
            self.assertFalse(all_failed({**failed, "us": state}))
        self.assertFalse(all_failed({}))


if __name__ == "__main__":
    unittest.main()
