"""Manual, offline RAG evaluations. Scores are observations, never CI gates."""
import json
import os
import subprocess
from collections import Counter

from .report import validate_review
from .runner import evidence
from .store import BenchError, REPO, TOOL, atomic_json, canonical, digest, file_hash, read_json


VERSION = 1
STATES = ("succeeded", "failed", "unknown", "notRun", "invalid")


def require(condition, message):
    if not condition:
        raise BenchError(message)


def valid_items(items):
    return isinstance(items, list) and all(
        isinstance(item, dict) and isinstance(item.get("documentId"), str)
        and bool(item["documentId"]) and isinstance(item.get("content"), str)
        for item in items)


def fallback_used(value):
    if value is None:
        return False
    require(isinstance(value, dict) and type(value.get("used")) is bool,
            "Invalid rerank fallback record")
    return value["used"]


def parse_citations(samples):
    """Reuse the application's Markdown AST and citation plugin in one batch."""
    if not samples:
        return {}
    environment = {k: v for k, v in os.environ.items()
                   if k in {"PATH", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"}}
    try:
        process = subprocess.run(["node", "--experimental-strip-types", str(TOOL / "eval_citations.mjs")],
                                 input=canonical(samples), capture_output=True, env=environment, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise BenchError("Citation parsing requires Node 22.18+ and installed frontend dependencies (npm ci in frontend)") from None
    # Never print stderr: answers must not leak through parser diagnostics.
    require(process.returncode == 0,
            "Citation parsing failed; use Node 22.18+ and run npm ci in frontend")
    return json.loads(process.stdout)


def score_sample(case, task, row, suite, state, top_k, citation_checks=None, recorded_intent=None):
    result = {"sampleId": task["id"], "caseId": case["id"], "group": case["group"],
              "category": case["category"], "mode": task.get("mode"),
              "split": case.get("split", "unspecified"), "topic": case.get("topic", "unspecified"),
              "positive": bool(case["evidence"]), "requiredUnits": len(case["evidence"]),
              "status": "notRun", "issues": [], "evidence": None}
    if row is None:
        result["issues"].append("sample_not_run")
        return result
    if row.get("state") == "in_flight":
        result.update(status="unknown", issues=["sample_unconfirmed"])
        return result
    require(row.get("state") == "finished" and type(row.get("ok")) is bool,
            "Invalid sample state")
    if not row["ok"]:
        result.update(status="failed", issues=["request_failed"])
        return result
    payload = row.get("body") if suite == "retrieval" else row
    items = payload.get("items" if suite == "retrieval" else "citations") if isinstance(payload, dict) else None
    if not valid_items(items) or (suite == "quality" and (
            not isinstance(row.get("answer"), str) or not row["answer"].strip()
            or row.get("answerStatus") not in {"answered", "no_basis", "model_refused", "retrieval_failed"})):
        result.update(status="invalid", issues=["invalid_response"])
        return result
    result["status"] = "succeeded"
    result["evidence"] = evidence(case, items, state, top_k if suite == "retrieval" else len(items))
    if result["positive"] and not result["evidence"]["completeEvidence"]:
        result["issues"].append("incomplete_evidence")
    # Reconciled records do not retain fallback metadata; do not invent False.
    result["rerankFallback"] = (fallback_used(payload["rerankFallback"])
                                if "rerankFallback" in payload else None)
    if result["rerankFallback"]:
        result["issues"].append("rerank_fallback")
    if suite == "quality":
        tags = citation_checks["numbers"]
        valid = citation_checks["sourceIndexesValid"]
        cited = [items[n - 1] for n in tags]
        result.update(answerStatus=row["answerStatus"], sourceIndexesValid=valid,
                      hasInlineCitation=bool(tags),
                      citedEvidence=evidence(case, cited, state, len(cited)),
                      answerHash=digest({"answer": row["answer"], "citations": items}),
                      reviewVerdict="pending", missingInformationHandled=None)
        intent = row.get("done", {}).get("assistantMessage", {}).get("intent") or recorded_intent
        result["intent"] = intent if intent in {"knowledge_base", "general", "conversation"} else "unknown"
        result["expectedIntent"] = case.get("expectedIntent")
        if result["expectedIntent"] and result["intent"] != result["expectedIntent"]:
            result["issues"].append("intent_unknown" if result["intent"] == "unknown" else "unexpected_intent")
        if not valid:
            result["issues"].append("invalid_source_index")
        if result["positive"] and not tags:
            result["issues"].append("missing_inline_citation")
        if result["positive"] and not result["citedEvidence"]["completeEvidence"]:
            result["issues"].append("incomplete_cited_evidence")
        if row["answerStatus"] == "retrieval_failed":
            result["issues"].append("retrieval_failed")
    return result


def ratio(numerator, denominator):
    return {"numerator": numerator, "denominator": denominator,
            "value": numerator / denominator if denominator else None}


def summarize_samples(rows, suite, profile):
    counts = Counter(row["status"] for row in rows)
    ok = [row for row in rows if row["status"] == "succeeded"]
    positive = [row for row in rows if row["positive"]]
    supported = [row for row in ok if row["positive"]]
    metrics = {"requestSuccessRate": ratio(len(ok), len(rows)),
               "completeEvidenceRate": ratio(sum(row["evidence"]["completeEvidence"] for row in supported), len(positive)),
               "evidenceUnitRecall": ratio(sum(row["evidence"]["coveredUnits"] for row in supported),
                                           sum(row["requiredUnits"] for row in positive)),
               "documentRecall": ratio(sum(row["evidence"]["documentRecall"] for row in supported), len(positive)),
               "documentMRR": ratio(sum(row["evidence"]["documentMRR"] for row in supported), len(positive))}
    result = {"planned": len(rows), **{key: counts[key] for key in STATES},
              "positivePlanned": len(positive), "metrics": metrics,
              "rerankFallbacks": sum(row.get("rerankFallback") is True for row in ok),
              "fallbackUnknown": sum(row.get("rerankFallback") is None for row in ok)}
    if suite == "quality":
        result["intents"] = dict(Counter(row.get("intent", "unknown") for row in ok))
        metrics.update({"sourceIndexValidityRate": ratio(sum(row["sourceIndexesValid"] for row in ok), len(rows)),
                        "inlineCitationRate": ratio(sum(row["hasInlineCitation"] for row in supported), len(positive)),
                        "citedEvidenceRate": ratio(sum(row["citedEvidence"]["completeEvidence"] for row in supported), len(positive))})
        verdicts = Counter(row["reviewVerdict"] for row in ok)
        reviewed = sum(verdicts[v] for v in ("pass", "partial", "fail"))
        available = profile == "real" and reviewed == len(rows) and bool(rows)
        missing = [row for row in rows if not row["positive"]]
        missing_reviewed = [row for row in missing if row.get("reviewVerdict") in {"pass", "partial", "fail"}]
        result["review"] = {**{v: verdicts[v] for v in ("pass", "partial", "fail", "pending")},
                            "unavailable": len(rows) - len(ok),
                            "status": "fixture" if profile == "fixture" else "complete" if available else "pending"}
        metrics["semanticPassRate"] = ratio(verdicts["pass"], len(rows)) if available else ratio(0, 0)
        metrics["missingInformationHandledRate"] = (
            ratio(sum(row["missingInformationHandled"] for row in missing_reviewed), len(missing))
            if profile == "real" and len(missing_reviewed) == len(missing) else ratio(0, 0))
    return result


def evaluate(run):
    """Snapshot and score saved observations without accessing any live service."""
    inputs = {}
    def read(path):
        value = read_json(path)
        inputs[str(path.relative_to(run.root))] = digest(value)
        return value

    manifest = read(run.root / "manifest.json")
    data = read(run.root / "dataset.json")
    require(digest(data) == manifest["datasetHash"], "Frozen dataset changed; cannot evaluate")
    require(manifest["profile"] in {"fixture", "real"}, "Invalid evaluation profile")
    state = read(run.root / "state.json")
    cases = {case["id"]: case for case in data["cases"]}
    require(bool(cases) and len(cases) == len(data["cases"]), "Empty or duplicate evaluation cases")
    for case in cases.values():
        require(all(isinstance(case.get(key), str) and case[key] for key in ("id", "group", "category", "question"))
                and isinstance(case.get("evidence"), list), "Invalid evaluation case")
        for unit in case["evidence"]:
            doc = data["documents"].get(unit["doc"])
            require(doc is not None and doc["group"] == case["group"] and bool(unit["anchors"])
                    and all(isinstance(a, str) and a.strip() for a in unit["anchors"]), "Invalid evidence unit")
            document = state.get("documents", {}).get(unit["doc"], {})
            require(isinstance(document.get("id"), str) and bool(document["id"]), "Missing run document mapping")
    cohorts = []
    for path in sorted((run.root / "cohorts").glob("*/plan.json")):
        plan = read_json(path)
        suite = plan["config"]["suite"]
        if suite not in {"retrieval", "quality"}:
            continue
        plan = read(path)
        require(plan["name"] == path.parent.name and plan["name"] == suite
                and plan["runId"] == manifest["runId"] and plan["datasetHash"] == manifest["datasetHash"],
                "Cohort identity does not match run")
        tasks = plan["plan"]
        require(isinstance(tasks, list) and bool(tasks), "Empty evaluation cohort")
        ids = [task["id"] for task in tasks]
        require(all(isinstance(key, str) and key for key in ids) and len(set(ids)) == len(ids), "Duplicate or invalid task IDs")
        top_k = plan["config"].get("topK", 5)
        require(type(top_k) is int and 1 <= top_k <= 20, "Invalid evaluation topK")
        records = {}
        for sample_path in sorted((path.parent / "samples").glob("*.json")):
            row = read(sample_path)
            key = row["sampleId"]
            require(key in ids and key not in records, "Duplicate or unplanned sample")
            records[key] = row
        intents = {}
        metadata_path = path.parent / "message-metadata.json"
        if suite == "quality" and metadata_path.exists():
            metadata = read(metadata_path)
            if metadata.get("status") == "available":
                intents = {item["clientRequestId"]: item.get("intent") for item in metadata.get("messages", [])}
        citation_checks = parse_citations([
            {"sampleId": key, "answer": row["answer"], "citationCount": len(row["citations"])}
            for key, row in records.items() if row.get("state") == "finished" and row.get("ok") is True
            and isinstance(row.get("answer"), str) and valid_items(row.get("citations"))
        ]) if suite == "quality" else {}
        scored, seen = [], set()
        for task in tasks:
            require(task.get("caseId") in cases, "Unknown case in evaluation plan")
            case = cases[task["caseId"]]
            if suite == "retrieval":
                require(task.get("mode") in plan["config"]["modes"], "Unknown retrieval mode")
            else:
                require(task["id"] == task["caseId"], "Quality sample ID must match case ID")
            identity = (task["caseId"], task.get("mode"))
            require(identity not in seen, "Repeated evaluation case/mode")
            seen.add(identity)
            row = records.get(task["id"])
            require(row is None or row.get("task") == task, "Sample task does not match plan")
            scored.append(score_sample(case, task, row, suite, state, top_k, citation_checks.get(task["id"]),
                                       intents.get((row or {}).get("clientRequestId"))))
        cohorts.append({"name": plan["name"], "suite": suite, "config": plan["config"],
                        "taskPlanHash": digest(tasks), "samples": scored})
    require(bool(cohorts), "No retrieval or quality cohort to evaluate")
    quality = next((c for c in cohorts if c["suite"] == "quality"), None)
    review_path = run.root / "review.json"
    reviewer = None
    if quality and review_path.exists():
        review = read(review_path)
        expected = {"runId": manifest["runId"], "labels": [row for row in quality["samples"] if row["status"] == "succeeded"]}
        validate_review(run, review, expected)
        reviewer = {"reviewer": review["reviewer"], "method": review["method"]}
        labels = {label["sampleId"]: label for label in review["labels"]}
        for row in quality["samples"]:
            if row["sampleId"] in labels:
                label = labels[row["sampleId"]]
                row.update(reviewVerdict=label["verdict"], missingInformationHandled=label.get("missingInformationHandled"))
                if label["verdict"] in {"partial", "fail"}:
                    row["issues"].append("semantic_review_" + label["verdict"])
    for cohort in cohorts:
        suite, rows = cohort["suite"], cohort["samples"]
        cohort["summary"] = summarize_samples(rows, suite, manifest["profile"])
        cohort["breakdowns"] = {}
        # Never average different retrieval modes into a single quality score.
        dimensions = ("mode",) if suite == "retrieval" else ("group", "category", "split", "topic")
        for dimension in dimensions:
            cohort["breakdowns"][dimension] = {
                value: summarize_samples([r for r in rows if r[dimension] == value], suite, manifest["profile"])
                for value in sorted({r[dimension] for r in rows})}
        if suite == "retrieval":
            cohort["summary"].pop("metrics")
            for mode, summary in cohort["breakdowns"]["mode"].items():
                summary["bySplit"] = {split: summarize_samples(
                    [r for r in rows if r["mode"] == mode and r["split"] == split], suite, manifest["profile"])
                    for split in sorted({r["split"] for r in rows if r["mode"] == mode})}
                summary["byCategory"] = {category: summarize_samples(
                    [r for r in rows if r["mode"] == mode and r["category"] == category], suite, manifest["profile"])
                    for category in sorted({r["category"] for r in rows if r["mode"] == mode})}
    complete = all(all(c["summary"][key] == 0 for key in STATES if key != "succeeded") for c in cohorts)
    return {"schemaVersion": VERSION, "runId": manifest["runId"], "profile": manifest["profile"],
            "status": "complete" if complete else "incomplete", "datasetHash": manifest["datasetHash"],
            "sourceCommit": manifest["sourceCommit"], "models": manifest["models"],
            "measurementIdentity": {k: v for k, v in manifest["sourceIdentity"].items()
                                    if k in {"benchmarks/runner.py", "benchmarks/client.py", "benchmarks/fixture.py", "benchmarks/runtime.py", "benchmarks/store.py"}},
            "scorerIdentity": {name: file_hash(REPO / name) for name in (
                "benchmarks/evals.py", "benchmarks/eval_citations.mjs", "benchmarks/runner.py", "benchmarks/report.py", "benchmarks/store.py",
                "frontend/src/pages/Chat/remarkCitations.ts", "frontend/package-lock.json")},
            "inputHashes": inputs, "reviewer": reviewer, "cohorts": cohorts,
            "limitations": ["Descriptive evaluation only; no quality thresholds or CI gate.",
                            "Automatic scores measure evidence anchors and citation structure, not factual correctness.",
                            "Planned denominators retain failed, unknown and unrun samples as zero credit.",
                            "Semantic rates require complete answer-bound reviews and a real model profile.",
                            "Fixture observations and historical runs do not establish current model quality."]}


def metric_rows(report):
    for cohort in report["cohorts"]:
        if cohort["suite"] == "retrieval":
            for mode, summary in cohort["breakdowns"]["mode"].items():
                yield "retrieval/" + mode, summary
        else:
            yield "quality", cohort["summary"]


def compare_evals(baseline, candidate):
    reasons = []
    for key in ("schemaVersion", "profile", "datasetHash", "models", "measurementIdentity", "scorerIdentity"):
        if baseline[key] != candidate[key]:
            reasons.append(key + " differs")
    def workloads(report):
        return {c["name"]: {"plan": c["taskPlanHash"],
                            "config": {k: v for k, v in c["config"].items() if k != "indexHash"}}
                for c in report["cohorts"]}
    if workloads(baseline) != workloads(candidate):
        reasons.append("workload differs")
    if baseline["status"] != "complete" or candidate["status"] != "complete":
        reasons.append("measurements incomplete")
    rows = []
    if not reasons:
        prior = dict(metric_rows(baseline))
        for scope, summary in metric_rows(candidate):
            for name, metric in summary["metrics"].items():
                old, new = prior[scope]["metrics"][name]["value"], metric["value"]
                rows.append({"scope": scope, "metric": name, "baseline": old, "candidate": new,
                             "delta": new - old if old is not None and new is not None else None})
    return {"baselineRunId": baseline["runId"], "baselineInputHashes": baseline["inputHashes"],
            "comparable": not reasons, "reasons": reasons, "metrics": rows,
            "interpretation": "Candidate minus baseline; descriptive changes, not a pass/fail decision or causal claim."}


def cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def number(value):
    return "—" if value is None else f"{value:.4f}"


def write_evals(run, baseline=None):
    report = evaluate(run)
    if baseline is not None:
        report["comparison"] = compare_evals(baseline, report)
    lines = ["# RAG Evals", "", f"运行：{cell(report['runId'])}；模式：{report['profile']}；采样状态：{report['status']}。",
             "", "手动离线评测；不设质量阈值或 CI 门禁。complete 只表示计划样本均有可评分响应，不代表质量通过。",
             "", "自动评分仅衡量依据锚点覆盖与引用结构，不等于事实正确率。fixture 不代表真实模型质量。",
             "", "## 样本状态", "", "| 范围 | 计划 | 成功 | 失败 | 未确认 | 未运行 | 无效 |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for cohort in report["cohorts"]:
        summary = cohort["summary"]
        lines.append("| " + cohort["name"] + " | " + " | ".join(str(summary[k]) for k in ("planned", *STATES)) + " |")
    lines += ["", "## 指标", "", "| 范围 | 指标 | 分子 | 分母 | 值 |", "| --- | --- | --- | --- | --- |"]
    for scope, summary in metric_rows(report):
        for name, metric in summary["metrics"].items():
            lines.append(f"| {scope} | {name} | {number(metric['numerator'])} | {metric['denominator']} | {number(metric['value'])} |")
    lines += ["", "检索按 TopK；回答依据覆盖使用返回的全部 citations，citedEvidenceRate 只检查正文实际标注的片段。",
              "失败、未确认、未运行与无效响应在计划分母中得 0 分；缺资料题不计入依据覆盖分母。",
              "documentRecall/MRR 的分子为逐题分数之和，分母为计划正例题数；MRR 使用首个目标文档的排名。",
              "引用编号全部有效但未标引用时，sourceIndexValidityRate 可为 1；须结合 inlineCitationRate 阅读。",
              "语义未全部审核或使用 fixture 时语义率显示 —，审核标签仍在 JSON 中保留。",
              "", "## 题型与分组", "", "| 范围 | 分类 | 计划 | 完整依据率 | 语义通过率 |", "| --- | --- | --- | --- | --- |"]
    for cohort in report["cohorts"]:
        breakdowns = cohort["breakdowns"]
        groups = (("retrieval/" + mode, summary["byCategory"]) for mode, summary in breakdowns["mode"].items()) if cohort["suite"] == "retrieval" else (
            ("quality/" + dimension, values) for dimension, values in breakdowns.items())
        for scope, values in groups:
            for label, summary in values.items():
                lines.append("| " + " | ".join([scope, cell(label), str(summary["planned"]),
                    number(summary["metrics"]["completeEvidenceRate"]["value"]),
                    number(summary["metrics"].get("semanticPassRate", {}).get("value"))]) + " |")
    lines += ["", "## 逐题发现", "", "| 范围 | 题目 | 题型 | 状态 | 发现 | 审核 |", "| --- | --- | --- | --- | --- | --- |"]
    for cohort in report["cohorts"]:
        for row in cohort["samples"]:
            lines.append("| " + " | ".join(cell(v) for v in (
                cohort["name"], row["sampleId"], row["category"], row["status"],
                ", ".join(row["issues"]) or "—", row.get("reviewVerdict", "N/A"))) + " |")
    if baseline is not None:
        comparison = report["comparison"]
        lines += ["", "## 基线对比", "", "基线：" + cell(comparison["baselineRunId"]), "",
                  "可比较。差值为候选减基线，无通过/失败阈值。" if comparison["comparable"] else "不可比较：" + cell(", ".join(comparison["reasons"])),
                  "", "| 范围 | 指标 | 基线 | 候选 | 差值 |", "| --- | --- | --- | --- | --- |"]
        for metric in comparison["metrics"]:
            lines.append("| " + " | ".join([metric["scope"], metric["metric"], *[number(metric[k]) for k in ("baseline", "candidate", "delta")]]) + " |")
    lines += ["", "分组、题型、逐题分数与内容身份见 evals.json；原始答案与引用保留在 cohorts/*/samples。", ""]
    atomic_json(run.root / "evals.json", report)
    (run.root / "evals.md").write_text("\n".join(lines), encoding="utf-8")
    return report
