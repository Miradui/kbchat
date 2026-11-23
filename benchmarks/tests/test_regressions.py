"""Independent regression scenarios discovered during suite review."""
import json
import tempfile
import unittest
import concurrent.futures
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from benchmarks.report import compare, import_review, review_template
from benchmarks.runner import Budget, load
from benchmarks.runtime import LABEL, Runtime
from benchmarks.store import BenchError, atomic_json
from test_benchmark import test_run
from benchmarks.__main__ import measured_exit


class ReviewRegressions(unittest.TestCase):
    def test_failed_or_unknown_measurement_is_nonzero_exit(self):
        for field in ("failed", "unknown", "notRun"):
            cohort = {"config": {"suite": "quality"}, "failed": 0, "unknown": 0, "notRun": 0}
            cohort[field] = 1
            self.assertEqual(measured_exit({"cohorts": [cohort]}, "quality"), 1)
        self.assertEqual(measured_exit({"cohorts": []}, "quality"), 1)

    def test_initializer_committed_marker_allows_restart_without_reapplying_sql(self):
        with tempfile.TemporaryDirectory() as folder:
            run = test_run(Path(folder))
            run.manifest["models"]["EMBEDDING_DIMENSION"] = "64"
            runtime = Runtime(run)
            calls = []
            marker = []
            def sql(statement):
                calls.append(statement)
                if statement.startswith("SELECT to_regclass"):
                    return "t" if marker else "f"
                if statement.startswith("SELECT count"):
                    return "0"
                if statement.startswith("SELECT run_id"):
                    return marker[0]
                self.assertTrue(statement.startswith("BEGIN;"))
                self.assertTrue(statement.endswith("COMMIT;"))
                import re
                match = re.search("INSERT INTO kbchat_benchmark.identity VALUES\\('([^']+)','([^']+)'\\)", statement)
                self.assertIsNotNone(match)
                marker.append(match[1] + ":" + match[2])
                raise BenchError("lost commit receipt")
            with patch.object(runtime, "sql", side_effect=sql):
                with self.assertRaises(BenchError):
                    runtime.initialize_schema()
                runtime.initialize_schema()
            self.assertEqual(sum(c.startswith("BEGIN;") for c in calls), 1)

    def test_request_budget_is_atomic_under_concurrency(self):
        with tempfile.TemporaryDirectory() as folder:
            run = test_run(Path(folder))
            run.manifest["maxModelRequests"] = 3
            budget = Budget(run)
            def reserve(_):
                try:
                    budget.reserve()
                    return True
                except BenchError:
                    return False
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                outcomes = list(pool.map(reserve, range(20)))
            self.assertEqual(sum(outcomes), 3)
            self.assertEqual(budget.value["reservedRequests"], 3)

    def test_retrieval_tuple_configuration_survives_json_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            run = test_run(Path(folder))
            config = {"suite": "retrieval", "modes": {"vector": (False, False, 0)}}
            run.cohort("retrieval", config, [{"id": "case"}])
            run.cohort("retrieval", config, [{"id": "case"}])

    def test_missing_information_failure_cannot_be_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            run = test_run(Path(folder))
            run.data["cases"][0].update(evidence=[], category="missing_information")
            journal = run.cohort("quality", {"suite": "quality"}, [{"id": "case"}])
            journal.finish(journal.begin("case", {}), {"ok": True, "answer": "invented", "citations": []})
            labels = review_template(run)
            labels.update(reviewer="reviewer", method="source review")
            labels["labels"][0].update(verdict="pass", factsCorrect=True, complete=True,
                                      citationsSupported=True, missingInformationHandled=False, note="contradictory judgement")
            path = Path(folder) / "labels.json"
            atomic_json(path, labels)
            with self.assertRaises(BenchError):
                import_review(run, path)

    def test_unreviewed_quality_does_not_pass_comparison_gate(self):
        value = {"profile": "real", "datasetHash": "same", "models": {}, "host": {},
                 "docker": {"cpus": 2, "memoryBytes": 2, "serverVersion": "x"},
                 "runtime": {"images": {"postgres": "p", "redis": "r"}}, "cohorts": [],
                 "qualityReview": {"plannedQualityCases": 1, "unreviewedSuccessful": 1, "reviewer": None}}
        self.assertFalse(compare(value, value)["compatible"])

    def test_cumulative_vector_budget_includes_existing_sizes(self):
        with tempfile.TemporaryDirectory() as folder:
            run = test_run(Path(folder))
            run.manifest["models"]["EMBEDDING_DIMENSION"] = "1024"
            run.save_state({"phase": "running", "synthetic": {"20000": {"complete": True}}})
            with patch("benchmarks.runner.synthetic", side_effect=AssertionError("budget must be checked before mutation")):
                with self.assertRaisesRegex(BenchError, "budget"):
                    load(run, [10000], 1, [1])

    def test_named_unlabelled_volume_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            run = test_run(Path(folder))
            run.manifest.update(project="owned", docker={"id": "daemon"})
            runtime = Runtime(run)
            def fake(args, *_, **__):
                if args[0] == "info":
                    return SimpleNamespace(stdout=b"daemon\n")
                if args[:2] == ["volume", "inspect"]:
                    return SimpleNamespace(stdout=json.dumps([{"Labels": {}}]).encode())
                if args[:2] == ["volume", "ls"] and "--filter" not in args:
                    return SimpleNamespace(stdout=b"owned_postgres_data\n")
                return SimpleNamespace(stdout=b"")
            with patch.object(runtime, "check_private"), patch.object(runtime, "docker", side_effect=fake):
                with self.assertRaisesRegex(BenchError, "ownership"):
                    runtime.guard()

    def test_changed_runtime_image_prevents_client_even_if_state_running(self):
        with tempfile.TemporaryDirectory() as folder:
            run = test_run(Path(folder))
            run.manifest.update(profile="real", models={"EMBEDDING_DIMENSION": "64"})
            run.save_state({"phase": "running", "api": "http://127.0.0.1:1234/api/v1"})
            atomic_json(run.root / "runtime-identity.json",
                        {"images": {"backend": "old", "postgres": "p", "redis": "r"}, "dimension": 64})
            runtime = Runtime(run)
            def service(name):
                return {"Image": "new" if name == "backend" else name[0],
                        "NetworkSettings": {"Ports": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "1234"}]}}}
            with patch.object(runtime, "guard"), patch.object(runtime, "service", side_effect=service), patch.object(runtime, "credentials", return_value={"admin": "x"}), patch("benchmarks.runtime.Client"):
                with self.assertRaisesRegex(BenchError, "images changed"):
                    runtime.client()


if __name__ == "__main__":
    unittest.main()
