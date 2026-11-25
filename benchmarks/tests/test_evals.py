"""Independent golden observations for manual RAG scoring, without live models."""
import contextlib
import copy
import io
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmarks.__main__ import main
from benchmarks.evals import compare_evals, evaluate, parse_citations, write_evals
from benchmarks.store import BenchError, REPO, Run, atomic_json, digest, read_json


def saved_run(root, profile="real"):
    data = {"spec": {"groups": {"g": "group"}}, "documents": {
        "a": {"group": "g", "content": "alpha"}, "b": {"group": "g", "content": "beta"}},
        "cases": [
            {"id": "one", "group": "g", "category": "supported", "question": "q1",
             "evidence": [{"doc": "a", "anchors": ["alpha"]}]},
            {"id": "cross", "group": "g", "category": "cross_document", "question": "q2",
             "evidence": [{"doc": "a", "anchors": ["alpha"]}, {"doc": "b", "anchors": ["beta"]}]},
            {"id": "missing", "group": "g", "category": "missing_information", "question": "q3", "evidence": []}]}
    atomic_json(root / "dataset.json", data)
    atomic_json(root / "manifest.json", {"schemaVersion": 1, "runId": root.name,
        "runDirectory": str(root.resolve()), "profile": profile, "datasetHash": digest(data),
        "sourceCommit": "baseline", "sourceIdentity": {"benchmarks/runner.py": "recorded-runner"}, "models": {}})
    run = Run(root)
    run.save_state({"documents": {"a": {"id": "doc-a"}, "b": {"id": "doc-b"}}})
    return run


ALPHA = {"documentId": "doc-a", "content": "AL PHA"}
BETA = {"documentId": "doc-b", "content": "beta"}
NOISE = {"documentId": "unrelated", "content": "alpha beta"}


def fixture_citations(samples):
    # Scoring unit tests use simple, valid literal markers. Markdown behavior is
    # independently exercised against the real application adapter below.
    return {sample["sampleId"]: {"numbers": list(dict.fromkeys(
        int(n) for n in re.findall(r"\[source: (\d+)\]", sample["answer"]))),
        "sourceIndexesValid": True} for sample in samples}


def saved_cohort(run, suite="quality", mode="standard", rows=None):
    tasks = [{"id": case["id"] + ("-" + mode if suite == "retrieval" else ""), "caseId": case["id"],
              **({"mode": mode} if suite == "retrieval" else {})} for case in run.data["cases"]]
    config = {"suite": suite, "indexHash": "runtime-dependent"}
    if suite == "retrieval":
        config.update(topK=5, modes={mode: [True, True, .3]})
    journal = run.cohort(suite, config, tasks)
    if rows is None:
        rows = [{"ok": True, "answer": "alpha [source: 2]", "answerStatus": "answered",
                 "citations": [NOISE, ALPHA], "rerankFallback": None},
                {"ok": True, "answer": "alpha [source: 1]", "answerStatus": "answered",
                 "citations": [ALPHA], "rerankFallback": {"used": True}},
                {"ok": True, "answer": "unknown", "answerStatus": "answered", "citations": [], "rerankFallback": None}]
        if suite == "retrieval":
            rows = [{"ok": True, "body": {"items": row["citations"], "rerankFallback": row["rerankFallback"]}} for row in rows]
    for task, row in zip(tasks, rows):
        if row is None:
            continue
        pending = journal.begin(task["id"], {"task": task})
        if row.get("state") != "in_flight":
            journal.finish(pending, row)
    return journal


def add_review(run, verdicts=("pass", "partial", "pass")):
    rows = evaluate(run)["cohorts"][0]["samples"]
    review = {"schemaVersion": 1, "runId": run.manifest["runId"], "reviewer": "test reviewer",
              "method": "compare answer against source", "labels": []}
    for row, verdict in zip(rows, verdicts):
        review["labels"].append({"sampleId": row["sampleId"], "answerHash": row["answerHash"],
            "verdict": verdict, "factsCorrect": True, "complete": verdict == "pass",
            "citationsSupported": True, "missingInformationHandled": not row["positive"], "note": "checked"})
    atomic_json(run.root / "review.json", review)
    return review


class EvalsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run = saved_run(self.root)
        parser = patch("benchmarks.evals.parse_citations", side_effect=fixture_citations)
        parser.start()
        self.addCleanup(parser.stop)

    def test_golden_rank_and_evidence_scores_use_planned_positives(self):
        saved_cohort(self.run, "retrieval")
        report = evaluate(self.run)
        cohort = report["cohorts"][0]
        self.assertNotIn("metrics", cohort["summary"])
        metrics = cohort["breakdowns"]["mode"]["standard"]["metrics"]
        self.assertEqual(metrics["completeEvidenceRate"], {"numerator": 1, "denominator": 2, "value": .5})
        self.assertAlmostEqual(metrics["evidenceUnitRecall"]["value"], 2 / 3)
        self.assertEqual(metrics["documentRecall"]["value"], .75)
        self.assertEqual(metrics["documentMRR"]["value"], .75)
        self.assertEqual(cohort["samples"][2]["evidence"], {"applicable": False})

    def test_cited_evidence_uses_only_marked_sources_and_all_returned_citations(self):
        journal = saved_cohort(self.run)
        row = journal.get("cross")
        row.update(citations=[ALPHA, BETA], checks={"evidence": {"completeEvidence": True}})
        atomic_json(journal.path("cross"), row)
        report = evaluate(self.run)
        metrics = report["cohorts"][0]["summary"]["metrics"]
        self.assertEqual(metrics["completeEvidenceRate"]["value"], 1)
        self.assertEqual(metrics["citedEvidenceRate"]["value"], .5)
        self.assertIsNone(metrics["semanticPassRate"]["value"])
        self.assertIn("incomplete_cited_evidence", report["cohorts"][0]["samples"][1]["issues"])
        # A relevant citation at position six still counts for answer context.
        row = journal.get("one")
        row.update(citations=[NOISE] * 5 + [ALPHA], answer="alpha [source: 6]")
        atomic_json(journal.path("one"), row)
        self.assertTrue(evaluate(self.run)["cohorts"][0]["samples"][0]["citedEvidence"]["completeEvidence"])

    def test_retrieval_topk_excludes_later_evidence(self):
        journal = saved_cohort(self.run, "retrieval")
        row = journal.get("one-standard")
        row["body"]["items"] = [NOISE] * 5 + [ALPHA]
        atomic_json(journal.path("one-standard"), row)
        sample = evaluate(self.run)["cohorts"][0]["samples"][0]
        self.assertEqual(sample["evidence"]["documentMRR"], 0)
        self.assertFalse(sample["evidence"]["completeEvidence"])

    def test_failed_unknown_and_unrun_stay_in_denominators(self):
        saved_cohort(self.run, rows=[{"ok": False}, {"state": "in_flight"}, None])
        report = evaluate(self.run)
        summary = report["cohorts"][0]["summary"]
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual([summary[k] for k in ("planned", "failed", "unknown", "notRun")], [3, 1, 1, 1])
        self.assertEqual(summary["metrics"]["completeEvidenceRate"], {"numerator": 0, "denominator": 2, "value": 0})
        self.assertIsNone(summary["metrics"]["semanticPassRate"]["value"])

    def test_malformed_success_is_invalid_not_successful(self):
        saved_cohort(self.run, rows=[{"ok": True, "answer": "x", "citations": "bad"},
                                    {"ok": True, "answer": "", "citations": []}, None])
        report = evaluate(self.run)
        self.assertEqual(report["cohorts"][0]["summary"]["invalid"], 2)
        self.assertEqual(report["status"], "incomplete")

    def test_recovered_answer_scores_without_cached_checks_or_fallback(self):
        journal = saved_cohort(self.run)
        row = journal.get("one")
        row.pop("rerankFallback")
        row.update(reconciled=True, checks={"sourceIndexesValid": False})
        atomic_json(journal.path("one"), row)
        summary = evaluate(self.run)["cohorts"][0]["summary"]
        self.assertEqual(summary["fallbackUnknown"], 1)
        self.assertEqual(summary["rerankFallbacks"], 1)
        self.assertEqual(summary["metrics"]["sourceIndexValidityRate"]["value"], 1)

    def test_bound_review_produces_semantic_rate_and_missing_information_rate(self):
        saved_cohort(self.run)
        add_review(self.run)
        report = evaluate(self.run)
        summary = report["cohorts"][0]["summary"]
        self.assertEqual(summary["review"]["status"], "complete")
        self.assertAlmostEqual(summary["metrics"]["semanticPassRate"]["value"], 2 / 3)
        self.assertEqual(summary["metrics"]["missingInformationHandledRate"]["value"], 1)
        # Missing-information handling is a review judgement, independent of answerStatus.
        self.assertEqual(report["cohorts"][0]["samples"][2]["answerStatus"], "answered")

    def test_pending_review_has_no_semantic_accuracy(self):
        saved_cohort(self.run)
        add_review(self.run, ("pass", "pending", "pass"))
        summary = evaluate(self.run)["cohorts"][0]["summary"]
        self.assertIsNone(summary["metrics"]["semanticPassRate"]["value"])
        self.assertEqual(summary["review"]["pending"], 1)

    def test_fixture_review_never_claims_model_accuracy(self):
        self.run = saved_run(self.root, "fixture")
        saved_cohort(self.run)
        add_review(self.run)
        summary = evaluate(self.run)["cohorts"][0]["summary"]
        self.assertEqual(summary["review"]["status"], "fixture")
        self.assertIsNone(summary["metrics"]["semanticPassRate"]["value"])
        self.assertIsNone(summary["metrics"]["missingInformationHandledRate"]["value"])

    def test_stale_or_unjustified_missing_information_review_is_rejected(self):
        journal = saved_cohort(self.run)
        review = add_review(self.run)
        review["labels"][2]["missingInformationHandled"] = False
        atomic_json(self.root / "review.json", review)
        with self.assertRaisesRegex(BenchError, "must not invent"):
            evaluate(self.run)
        review["labels"][2]["missingInformationHandled"] = True
        atomic_json(self.root / "review.json", review)
        row = journal.get("one")
        row["answer"] = "changed"
        atomic_json(journal.path("one"), row)
        with self.assertRaisesRegex(BenchError, "changed answer"):
            evaluate(self.run)

    def test_frozen_dataset_and_plan_identity_are_checked(self):
        journal = saved_cohort(self.run)
        plan = read_json(journal.root / "plan.json")
        plan["runId"] = "another-run"
        atomic_json(journal.root / "plan.json", plan)
        with self.assertRaisesRegex(BenchError, "identity"):
            evaluate(self.run)
        atomic_json(self.root / "dataset.json", {"changed": True})
        with self.assertRaisesRegex(BenchError, "Frozen dataset changed"):
            evaluate(self.run)

    def test_duplicate_extra_and_wrong_task_samples_rejected(self):
        journal = saved_cohort(self.run)
        original = journal.get("one")
        extra = journal.samples / "extra.json"
        for row in (original, {**original, "sampleId": "unplanned"}):
            atomic_json(extra, row)
            with self.assertRaisesRegex(BenchError, "unplanned sample"):
                evaluate(self.run)
        extra.unlink()
        atomic_json(journal.path("one"), {**original, "task": {"id": "one", "caseId": "cross"}})
        with self.assertRaisesRegex(BenchError, "does not match plan"):
            evaluate(self.run)

    def test_no_cohort_empty_cohort_and_missing_mapping_are_errors(self):
        with self.assertRaisesRegex(BenchError, "No retrieval or quality"):
            evaluate(self.run)
        self.run.cohort("quality", {"suite": "quality"}, [])
        with self.assertRaisesRegex(BenchError, "Empty evaluation"):
            evaluate(self.run)
        self.run.save_state({"documents": {}})
        with self.assertRaisesRegex(BenchError, "Missing run document"):
            evaluate(self.run)

    def test_same_inputs_have_deterministic_scores_and_input_identity(self):
        journal = saved_cohort(self.run)
        report = evaluate(self.run)
        self.assertEqual(report, evaluate(self.run))
        row = journal.get("one")
        row["answer"] = "alpha [source: 1]"
        atomic_json(journal.path("one"), row)
        changed = evaluate(self.run)
        self.assertNotEqual(changed["inputHashes"], report["inputHashes"])
        self.assertEqual(changed["scorerIdentity"], report["scorerIdentity"])

    def test_comparison_reports_delta_without_pass_fail(self):
        journal = saved_cohort(self.run)
        before = evaluate(self.run)
        row = journal.get("cross")
        row.update(citations=[ALPHA, BETA], answer="alpha beta [source: 1] [source: 2]")
        atomic_json(journal.path("cross"), row)
        comparison = compare_evals(before, evaluate(self.run))
        metric = next(m for m in comparison["metrics"] if m["metric"] == "completeEvidenceRate")
        self.assertTrue(comparison["comparable"])
        self.assertEqual(metric["delta"], .5)
        self.assertNotIn("regression", comparison)
        self.assertNotIn("passed", comparison)

    def test_incompatible_comparison_and_pending_semantics_do_not_make_up_deltas(self):
        saved_cohort(self.run)
        before = evaluate(self.run)
        comparison = compare_evals(before, before)
        semantic = next(m for m in comparison["metrics"] if m["metric"] == "semanticPassRate")
        self.assertIsNone(semantic["delta"])
        for key in ("models", "datasetHash", "scorerIdentity", "measurementIdentity"):
            candidate = copy.deepcopy(before)
            candidate[key] = "changed"
            comparison = compare_evals(before, candidate)
            self.assertFalse(comparison["comparable"])
            self.assertEqual(comparison["metrics"], [])
        candidate = copy.deepcopy(before)
        candidate["cohorts"][0]["taskPlanHash"] = "new-plan"
        self.assertFalse(compare_evals(before, candidate)["comparable"])
        candidate = copy.deepcopy(before)
        candidate["status"] = "incomplete"
        self.assertFalse(compare_evals(before, candidate)["comparable"])

    def test_cli_is_offline_does_not_gate_quality_or_rewrite_other_reports(self):
        saved_cohort(self.run, rows=[{"ok": False}, None, None])
        (self.root / "report.md").write_text("existing report")
        # These failures guarantee the manual eval route cannot start Docker/API.
        with patch("benchmarks.__main__.Runtime", side_effect=AssertionError("runtime accessed")), \
             patch("benchmarks.store.source_identity", side_effect=AssertionError("current source checked")), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["evals", "--run", str(self.root), "--baseline", str(self.root)]), 0)
        self.assertEqual((self.root / "report.md").read_text(), "existing report")
        report = read_json(self.root / "evals.json")
        self.assertEqual(report["status"], "incomplete")
        self.assertFalse(report["comparison"]["comparable"])
        self.assertFalse((self.root / ".operation.lock").exists())
        self.assertIn("未运行", (self.root / "evals.md").read_text())

    def test_saved_report_has_per_case_findings_breakdowns_and_no_answers(self):
        saved_cohort(self.run, "retrieval")
        saved_cohort(self.run)
        result = write_evals(self.run)
        text = (self.root / "evals.md").read_text()
        self.assertIn("incomplete_evidence", text)
        self.assertIn("cross_document", text)
        self.assertIn("missing_information", text)
        self.assertEqual(result, read_json(self.root / "evals.json"))
        for cohort in result["cohorts"]:
            self.assertTrue(all("answer" not in row for row in cohort["samples"]))

    def test_expected_intent_is_checked_without_excluding_general_answers(self):
        self.run.data["cases"][0].update(expectedIntent="knowledge_base", split="test", topic="routing")
        atomic_json(self.root / "dataset.json", self.run.data)
        self.run.manifest["datasetHash"] = digest(self.run.data)
        atomic_json(self.root / "manifest.json", self.run.manifest)
        journal = saved_cohort(self.run)
        row = journal.get("one")
        row["clientRequestId"] = "request-one"
        atomic_json(journal.path("one"), row)
        atomic_json(journal.root / "message-metadata.json", {"status": "available", "messages": [
            {"clientRequestId": "request-one", "intent": "general"}]})
        report = evaluate(self.run)
        cohort = report["cohorts"][0]
        self.assertEqual(cohort["summary"]["planned"], 3)
        self.assertEqual(cohort["summary"]["intents"], {"general": 1, "unknown": 2})
        self.assertIn("unexpected_intent", cohort["samples"][0]["issues"])
        self.assertEqual(cohort["breakdowns"]["split"]["test"]["planned"], 1)
        self.assertIn("cohorts/quality/message-metadata.json", report["inputHashes"])


class CitationAdapterFailureTests(unittest.TestCase):
    def test_missing_parser_is_actionable_without_echoing_answer_or_stderr(self):
        with patch("benchmarks.evals.subprocess.run", side_effect=OSError("sensitive")):
            with self.assertRaisesRegex(BenchError, "Node 22.18") as error:
                parse_citations([{"sampleId": "one", "answer": "private answer", "citationCount": 1}])
        self.assertNotIn("sensitive", str(error.exception))
        self.assertNotIn("private answer", str(error.exception))


@unittest.skipUnless(shutil.which("node") and (REPO / "frontend/node_modules/react-markdown").exists(),
                     "Markdown integration needs Node 22.18+ and frontend npm ci; scorer unit tests remain Python-only")
class CitationAdapterTests(unittest.TestCase):
    def test_large_batch_streamed_through_subprocess_pipe(self):
        # Exceed pipe capacity with realistic Unicode answers. All records,
        # including the tail, must survive asynchronous stdin reads.
        samples = [{"sampleId": str(index), "answer": ("中文依据🙂 " * 300) + "[source: 1, 2]",
                    "citationCount": 2} for index in range(48)]
        try:
            result = parse_citations(samples)
        except BenchError as error:
            self.fail("A complete Unicode batch must be readable from the pipe: " + str(error))
        self.assertEqual(len(result), 48)
        self.assertTrue(all(result[str(i)] == {"numbers": [1, 2], "sourceIndexesValid": True}
                            for i in range(48)))

    def test_markdown_citation_contract(self):
        samples = [
            ("group", "alpha beta [source: 1, 2]", [1, 2], True),
            ("case_space", "[SOURCE: 1, 1, 2 ]", [1, 2], True),
            ("separate", "[source: 1] [source: 2]", [1, 2], True),
            ("bold", "**[source: 1, 2]**", [1, 2], True),
            ("escaped", r"\[source: 1\]", [1], True),
            ("entity", "&#91;source: 1&#93;", [1], True),
            ("code", "`[source: 1, 2]`", [], True),
            ("fence", "```text\n[source: 1] [source: 2]\n```", [], True),
            ("quote_fence", "> ```\n> [source: 1]\n> ```", [], True),
            ("indent", "    [source: 1]", [], True),
            ("link", "[existing [source: 1, 2]](https://example.com)", [], True),
            ("reference", "[existing [source: 1]][ref]\n\n[ref]: https://example.com", [], True),
            ("image", "![alt [source: 1]](https://example.com/image)", [], True),
            ("html", '<img alt="[source: 1]" />', [], True),
            ("unresolved_reference", "[source: 1][unknown]", [1], True),
            ("partial_group", "[source: 1, 3]", [], False),
            ("zero", "[source: 0]", [], False),
            ("negative", "[source: -1]", [], False),
            ("malformed", "[source: nope]", [], False),
            ("incomplete", "[source:", [], False),
            ("oversized", "[source:" + ",".join(["1"] * 21) + "]", [], False),
            ("mixed", "[source: 1] [source: 3]", [1], False),
            ("unused_footnote", "alpha beta\n\n[^unused]: [source: 1, 2]", [], True),
            ("unused_invalid_footnote", "alpha beta\n\n[^unused]: [source: 99]", [], True),
            ("used_footnote", "alpha beta[^used]\n\n[^used]: [source: 1, 2]", [1, 2], True),
            ("used_invalid_footnote", "alpha beta[^used]\n\n[^used]: [source: 99]", [], False),
        ]
        result = parse_citations([{"sampleId": key, "answer": answer, "citationCount": 2}
                                  for key, answer, _, _ in samples])
        for key, _, numbers, valid in samples:
            with self.subTest(case=key):
                self.assertEqual(result[key], {"numbers": numbers, "sourceIndexesValid": valid})

    def test_real_adapter_feeds_scoring_and_cli(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            run = saved_run(root)
            journal = saved_cohort(run)
            row = journal.get("cross")
            row.update(citations=[ALPHA, BETA], answer="alpha beta [source: 1, 2]")
            atomic_json(journal.path("cross"), row)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["evals", "--run", str(root)]), 0)
            result = read_json(root / "evals.json")
            self.assertEqual(result["cohorts"][0]["summary"]["metrics"]["citedEvidenceRate"]["value"], 1)
            row["answer"] = "```\nalpha beta [source: 1] [source: 2]\n```"
            atomic_json(journal.path("cross"), row)
            sample = evaluate(run)["cohorts"][0]["samples"][1]
            self.assertFalse(sample["hasInlineCitation"])
            self.assertFalse(sample["citedEvidence"]["completeEvidence"])
            self.assertIn("missing_inline_citation", sample["issues"])


if __name__ == "__main__":
    unittest.main()
