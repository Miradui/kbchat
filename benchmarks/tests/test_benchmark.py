import contextlib
import io
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from benchmarks.__main__ import parser
from benchmarks.client import Client, events, validate_done
from benchmarks.report import cohort_summary, compare, import_review, write_report
from benchmarks.runtime import LABEL, Runtime, clean_env, compose_spec, models
from benchmarks.store import (BenchError, Journal, Run, atomic_json, cache_delta,
                              digest, distribution, exclusive, read_json)


def done(request="req", session="session"):
    return {"clientRequestId": request, "answer": "中文🙂", "citations": [],
            "userMessage": {"id": "u", "role": "user", "sessionId": session, "clientRequestId": request, "content": "question"},
            "assistantMessage": {"id": "a", "role": "assistant", "sessionId": session, "clientRequestId": request, "content": "中文🙂", "answerStatus": "answered"}}


def frame(event, body):
    return ("event: " + event + "\ndata: " + json.dumps(body, ensure_ascii=False) + "\n\n").encode()


@contextlib.contextmanager
def http_server(content, delay=0):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                if delay:
                    end = time.monotonic() + delay
                    while time.monotonic() < end:
                        self.wfile.write(b": heartbeat\n\n")
                        self.wfile.flush()
                        time.sleep(.02)
                else:
                    self.wfile.write(content)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port) + "/api/v1"
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def test_run(root):
    frozen = {"spec": {"groups": {"g": "group"}}, "documents": {},
              "cases": [{"id": "case", "group": "g", "question": "q", "evidence": [{"doc": "d", "anchors": ["x"]}]}]}
    manifest = {"schemaVersion": 1, "runId": "12345678" * 4, "runDirectory": str(root.resolve()),
                "profile": "fixture", "sourceIdentity": {}, "datasetHash": digest(frozen),
                "sourceCommit": "revision", "models": {}, "host": {}, "docker": {}}
    atomic_json(root / "manifest.json", manifest)
    atomic_json(root / "dataset.json", frozen)
    return Run(root)


class TransportTests(unittest.TestCase):
    def test_multiline_unicode_and_partial_event(self):
        lines = io.BytesIO(b': heartbeat\r\nevent: delta\r\ndata: {"text":\r\ndata: "\xe4\xb8\xad\xe6\x96\x87"}\r\n\r\nevent: done\ndata: {}\n')
        self.assertEqual(list(events(lines)), [("delta", {"text": "中文"})])

    def test_malformed_done_is_recorded_not_raised(self):
        for payload in ({"clientRequestId": "req"}, done(request="wrong"), {**done(), "assistantMessage": None}):
            with self.subTest(payload=payload), http_server(frame("done", payload)) as base:
                result = Client(base, 2).stream("session", "q", "req")
                self.assertFalse(result["ok"])
                self.assertIn(result["errorCode"], {"MALFORMED_DONE", "MISMATCHED_DONE_ID"})

    def test_error_cannot_be_overwritten_by_done(self):
        with http_server(frame("error", {"code": "UPSTREAM_FAILED"}) + frame("done", done())) as base:
            result = Client(base).stream("session", "q", "req")
            self.assertFalse(result["ok"])
            self.assertEqual(result["errorCode"], "UPSTREAM_FAILED")

    def test_done_only_has_no_invented_first_token(self):
        with http_server(frame("done", done())) as base:
            result = Client(base).stream("session", "q", "req")
            self.assertTrue(result["ok"])
            self.assertIsNone(result["firstDeltaMs"])
            self.assertEqual(distribution([None]), {"n": 0, "meanMs": None, "p50Ms": None, "p95Ms": None, "p99Ms": None, "maxMs": None})

    def test_truncated_stream_and_mismatched_content_fail(self):
        bodies = [frame("delta", {"text": "partial"}),
                  frame("done", {**done(), "answer": "different"})]
        for body in bodies:
            with self.subTest(body=body), http_server(body) as base:
                self.assertFalse(Client(base).stream("session", "q", "req")["ok"])

    def test_heartbeat_cannot_extend_total_deadline(self):
        with http_server(b"", delay=2) as base:
            started = time.monotonic()
            result = Client(base, .15).stream("session", "q", "req")
            elapsed = time.monotonic() - started
            self.assertEqual(result["errorCode"], "TOTAL_TIMEOUT")
            self.assertLess(elapsed, .8)


class PersistenceTests(unittest.TestCase):
    def test_unknown_sample_is_retained_and_completed_samples_not_restarted(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(Path(directory))
            pending = journal.begin("paid-request", {"clientRequestId": "stable"})
            reloaded = Journal(Path(directory))
            self.assertEqual(reloaded.get("paid-request")["state"], "in_flight")
            with self.assertRaises(BenchError):
                reloaded.begin("paid-request", {})
            reloaded.finish(pending, {"ok": True, "answer": "accepted"})
            self.assertEqual(journal.get("paid-request")["answer"], "accepted")
            self.assertFalse(list(Path(directory).rglob("*.tmp")))

    def test_source_or_frozen_dataset_change_refuses_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = test_run(root)
            with patch("benchmarks.store.source_identity", return_value={"changed": "hash"}):
                with self.assertRaisesRegex(BenchError, "changed"):
                    Run(root, check_inputs=True)
            atomic_json(root / "dataset.json", {"changed": True})
            with patch("benchmarks.store.source_identity", return_value={}):
                with self.assertRaisesRegex(BenchError, "dataset changed"):
                    Run(root, check_inputs=True)

    def test_exclusive_operation_and_changed_cohort_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = test_run(root)
            with exclusive(root):
                with self.assertRaises(BenchError):
                    with exclusive(root):
                        pass
            self.assertFalse((root / ".operation.lock").exists())
            run.cohort("quality", {"suite": "quality"}, [{"id": "1"}])
            with self.assertRaises(BenchError):
                run.cohort("quality", {"suite": "quality"}, [{"id": "2"}])


class IsolationTests(unittest.TestCase):
    def test_inherited_service_and_docker_environment_is_not_forwarded(self):
        dangerous = {"MINIO_ENDPOINT": "production", "OPENAI_API_KEY": "secret",
                     "RAG_TEST_POSTGRES_DSN": "production", "HTTP_PROXY": "proxy",
                     "COMPOSE_PROJECT_NAME": "production", "DOCKER_HOST": "tcp://remote"}
        with patch.dict(os.environ, dangerous):
            environment = clean_env()
            self.assertFalse(set(dangerous) & set(environment))

    def test_managed_stack_has_only_loopback_api_and_no_minio(self):
        spec = compose_spec(Path("/tmp/run"), "project", "owner", models(None, "fixture"),
                            "pg", "redis", "jwt", "admin", "fixture")
        self.assertNotIn("ports", spec["services"]["postgres"])
        self.assertNotIn("ports", spec["services"]["redis"])
        self.assertEqual(spec["services"]["redis"]["volumes"], ["redis_data:/data"])
        self.assertEqual(spec["volumes"]["redis_data"]["labels"][LABEL], "owner")
        api = spec["services"]["backend"]
        self.assertEqual(api["ports"][0]["host_ip"], "127.0.0.1")
        for key in ("MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"):
            self.assertEqual(api["environment"][key], "")
        self.assertEqual(api["labels"][LABEL], "owner")

    def test_resource_mismatch_prevents_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            run = test_run(Path(directory))
            run.manifest.update(project="owned", docker={"id": "daemon"})
            runtime = Runtime(run)
            calls = []
            def fake(args, *_, **__):
                calls.append(args)
                if args[0] == "info":
                    output = b"daemon\n"
                elif args[0] == "ps":
                    output = b"container\n"
                elif args[0] == "inspect":
                    output = json.dumps([{"Config": {"Labels": {LABEL: "another", "com.docker.compose.project": "owned"}}}]).encode()
                else:
                    self.fail("Mutation reached before ownership rejection: " + str(args))
                class Result:
                    stdout = output
                return Result()
            with patch.object(runtime, "check_private"), patch.object(runtime, "docker", side_effect=fake):
                with self.assertRaisesRegex(BenchError, "ownership"):
                    runtime.down(remove=True)
            self.assertFalse(any("down" in args for args in calls))

    def test_model_config_does_not_accept_implicit_real_target(self):
        with self.assertRaises(BenchError):
            models(None, "real")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "models.env"
            path.write_text("DATABASE_URL=production\n")
            with self.assertRaisesRegex(BenchError, "Unknown"):
                models(path, "real")

    def test_zero_negative_and_duplicate_cli_parameters_rejected(self):
        for value in ("0", "-1"):
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    parser().parse_args(["run", "--run", "/tmp/run", "--suite", "stream", "--requests", value])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser().parse_args(["run", "--run", "/tmp/run", "--suite", "load", "--concurrency", "1,1"])


class ReportTests(unittest.TestCase):
    def test_percentiles_and_counter_deltas(self):
        self.assertEqual(distribution([30, 0, 20, 10])["p50Ms"], 15)
        self.assertAlmostEqual(distribution([30, 0, 20, 10])["p95Ms"], 28.5)
        before = {"embeddingCache": {"hits": 90, "misses": 10, "errors": 0, "hitRate": .9}}
        after = {"embeddingCache": {"hits": 92, "misses": 18, "errors": 0, "hitRate": 92 / 110}}
        self.assertEqual(cache_delta(before, after)["hitRate"], .2)

    def test_last_mode_failure_does_not_drop_other_results(self):
        with tempfile.TemporaryDirectory() as directory:
            run = test_run(Path(directory))
            plan = [{"id": "case-vector", "caseId": "case", "mode": "vector"},
                    {"id": "case-standard", "caseId": "case", "mode": "standard"}]
            journal = run.cohort("retrieval", {"suite": "retrieval"}, plan)
            journal.finish(journal.begin("case-vector", {}), {"ok": True, "totalMs": 10,
                           "evidence": {"applicable": True, "completeEvidence": True, "documentRecall": 1}})
            journal.finish(journal.begin("case-standard", {}), {"ok": False, "errorCode": "timeout", "totalMs": 20})
            result = cohort_summary(journal.root, {"case": run.data["cases"][0]})
            self.assertEqual(result["retrieval"]["vector"]["completeEvidenceRatePlanned"], 1)
            self.assertEqual(result["retrieval"]["standard"]["completeEvidenceRatePlanned"], 0)
            self.assertEqual(result["failed"], 1)

    def test_all_failed_report_does_not_claim_quality_success(self):
        with tempfile.TemporaryDirectory() as directory:
            run = test_run(Path(directory))
            journal = run.cohort("quality", {"suite": "quality"}, [{"id": "case"}])
            journal.finish(journal.begin("case", {}), {"ok": False, "errorCode": "FAIL"})
            result = write_report(run)
            self.assertEqual(result["cohorts"][0]["succeeded"], 0)
            self.assertEqual(result["cohorts"][0]["latency"]["n"], 0)
            self.assertEqual(result["qualityReview"]["pass"], 0)
            self.assertIsNone(result["qualityReview"]["reviewer"])

    def test_stale_or_unjustified_review_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            run = test_run(Path(directory))
            journal = run.cohort("quality", {"suite": "quality"}, [{"id": "case"}])
            journal.finish(journal.begin("case", {}), {"ok": True, "answer": "current", "citations": []})
            path = Path(directory) / "import.json"
            atomic_json(path, {"runId": run.manifest["runId"], "reviewer": "reviewer", "method": "source comparison",
                               "labels": [{"sampleId": "case", "answerHash": "old", "verdict": "pass"}]})
            with self.assertRaises(BenchError):
                import_review(run, path)

    def test_incompatible_runs_and_missing_samples_not_compared(self):
        base = {"profile": "fixture", "datasetHash": "a", "models": {}, "host": {},
                "docker": {"cpus": 2, "memoryBytes": 10, "serverVersion": "x"},
                "runtime": {"images": {"postgres": "p", "redis": "r", "fixture": "f"}},
                "cohorts": [{"name": "x", "config": {"suite": "load"}, "planned": 2, "unknown": 0, "notRun": 0,
                             "failed": 0, "latency": {"p95Ms": 10}}]}
        candidate = json.loads(json.dumps(base))
        candidate["datasetHash"] = "b"
        self.assertFalse(compare(base, candidate)["compatible"])
        candidate["datasetHash"] = "a"
        candidate["cohorts"][0]["notRun"] = 1
        self.assertFalse(compare(base, candidate)["compatible"])
        candidate["cohorts"][0]["notRun"] = 0
        candidate["cohorts"][0]["latency"]["p95Ms"] = 20
        self.assertTrue(compare(base, candidate)["regression"])


if __name__ == "__main__":
    unittest.main()
