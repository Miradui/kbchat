"""Offline, data-derived reports, review labels, and compatible-run comparison."""
import json
import math
import zipfile
from collections import Counter

from .store import BenchError, Journal, atomic_json, cache_delta, digest, distribution, file_hash, now, read_json


def review_template(run):
    path = run.root / "cohorts" / "quality"
    if not (path / "plan.json").exists():
        raise BenchError("No quality cohort to review")
    rows = Journal(path).rows()
    labels = []
    for row in rows:
        if row["state"] == "finished" and row.get("ok"):
            labels.append({"sampleId": row["sampleId"], "answerHash": digest({
                "answer": row.get("answer"), "citations": row.get("citations")}),
                "verdict": "pending", "factsCorrect": None, "complete": None,
                "citationsSupported": None, "missingInformationHandled": None, "note": ""})
    return {"schemaVersion": 1, "runId": run.manifest["runId"], "reviewer": "",
            "method": "", "labels": labels}


def import_review(run, path):
    expected = review_template(run)
    submitted = read_json(path)
    if submitted.get("runId") != expected["runId"] or not submitted.get("reviewer") or not submitted.get("method"):
        raise BenchError("Review must identify this run, reviewer, and review method")
    known = {label["sampleId"]: label for label in expected["labels"]}
    cases = {case["id"]: case for case in run.data["cases"]}
    seen = set()
    for label in submitted["labels"]:
        key = label["sampleId"]
        if key in seen or key not in known or label.get("answerHash") != known[key]["answerHash"]:
            raise BenchError("Duplicate, unknown, or changed answer in review")
        seen.add(key)
        if label.get("verdict") not in {"pass", "partial", "fail", "pending"}:
            raise BenchError("Invalid review verdict")
        if label["verdict"] != "pending":
            if not label.get("note") or any(type(label.get(k)) is not bool for k in ("factsCorrect", "complete", "citationsSupported")):
                raise BenchError("Reviewed answers require boolean judgements and a reason")
            if label["verdict"] == "pass" and not all(label[k] for k in ("factsCorrect", "complete", "citationsSupported")):
                raise BenchError("A pass must meet all review criteria")
            if not cases[key]["evidence"]:
                if type(label.get("missingInformationHandled")) is not bool:
                    raise BenchError("Missing-information case requires an explicit judgement")
                if label["verdict"] == "pass" and not label["missingInformationHandled"]:
                    raise BenchError("A missing-information pass must not invent the requested value")
    target = run.root / "reviews" / (now().replace(":", "-") + ".json")
    atomic_json(target, submitted)
    atomic_json(run.root / "review.json", submitted)


def cohort_summary(directory, cases):
    plan = read_json(directory / "plan.json")
    rows = Journal(directory).rows()
    ids = [task["id"] for task in plan["plan"]]
    if len(ids) != len(set(ids)) or not {r["sampleId"] for r in rows} <= set(ids):
        raise BenchError("Sample set does not match cohort plan")
    finished = [r for r in rows if r["state"] == "finished"]
    ok = [r for r in finished if r.get("ok")]
    batches = [read_json(p) for p in directory.glob("batch-*.json")]
    seconds = sum(b["wallSeconds"] for b in batches)
    accounted = {b["id"] for b in batches}
    fully_accounted = all(row.get("batchId") in accounted for row in rows)
    result = {"name": plan["name"], "config": plan["config"], "planned": len(ids),
              "taskPlanHash": digest(plan["plan"]),
              "recorded": len(rows), "succeeded": len(ok), "failed": len(finished) - len(ok),
              "unknown": len(rows) - len(finished), "notRun": len(ids) - len(rows),
              "errors": dict(Counter(r.get("errorCode", "UNKNOWN") for r in finished if not r.get("ok"))),
              "latency": distribution([r.get("totalMs") for r in ok]),
              "firstDelta": distribution([r.get("firstDeltaMs") for r in ok]),
              "noFirstDelta": sum(r.get("firstDeltaMs") is None for r in ok),
              "answerStatus": dict(Counter(r.get("answerStatus") for r in ok if r.get("answerStatus"))),
              "driverCompletedRps": len(ok) / seconds if seconds and fully_accounted else None,
              "throughputScope": "cohort wall time includes setup, durable records and client overhead; not maximum server QPS",
              "cacheBatches": [cache_delta(b["before"], b["after"]) for b in batches]}
    metadata = directory / "message-metadata.json"
    if metadata.exists():
        value = read_json(metadata)
        result["intentMetadataStatus"] = value["status"]
        result["intents"] = dict(Counter(m["intent"] for m in value["messages"]))
    if plan["config"]["suite"] == "stream":
        result["reconciledWithoutTiming"] = sum(r.get("reconciled", False) for r in ok)
        result["rerankFallbacks"] = sum(bool(r.get("rerankFallback")) for r in ok)
        result["multiDelta"] = sum(r.get("deltaCount", 0) > 1 for r in ok)
    if plan["config"]["suite"] == "retrieval":
        groups = {}
        by_sample = {r["sampleId"]: r for r in rows}
        for task in plan["plan"]:
            mode = task["mode"]
            values = groups.setdefault(mode, {"planned": 0, "succeeded": 0, "positivePlanned": 0,
                                              "positiveSucceeded": 0, "completeEvidence": 0, "documentRecallSum": 0.})
            values["planned"] += 1
            positive = bool(cases[task["caseId"]]["evidence"])
            values["positivePlanned"] += positive
            row = by_sample.get(task["id"], {})
            if row.get("ok"):
                values["succeeded"] += 1
                if positive and row.get("evidence", {}).get("applicable"):
                    values["positiveSucceeded"] += 1
                    values["completeEvidence"] += row["evidence"]["completeEvidence"]
                    values["documentRecallSum"] += row["evidence"]["documentRecall"]
        for values in groups.values():
            values["completeEvidenceRatePlanned"] = values["completeEvidence"] / values["positivePlanned"] if values["positivePlanned"] else None
            values["completeEvidenceRateSuccessful"] = values["completeEvidence"] / values["positiveSucceeded"] if values["positiveSucceeded"] else None
        result["retrieval"] = groups
    return result


def summarize(run):
    cases = {case["id"]: case for case in run.data["cases"]}
    cohorts = [cohort_summary(p.parent, cases) for p in sorted((run.root / "cohorts").glob("*/plan.json"))]
    review = read_json(run.root / "review.json") if (run.root / "review.json").exists() else None
    reviews = {}
    if review:
        expected = {label["sampleId"]: label["answerHash"] for label in review_template(run)["labels"]}
        for label in review["labels"]:
            if expected.get(label["sampleId"]) != label["answerHash"]:
                raise BenchError("Stored review no longer matches measured answer")
            reviews[label["sampleId"]] = label
    quality = next((c for c in cohorts if c["config"]["suite"] == "quality"), None)
    counts = Counter(label["verdict"] for label in reviews.values())
    unreviewed = quality["succeeded"] - counts["pass"] - counts["partial"] - counts["fail"] if quality else 0
    review_summary = {"reviewer": review.get("reviewer") if review else None,
                      "method": review.get("method") if review else None, "pass": counts["pass"],
                      "partial": counts["partial"], "fail": counts["fail"],
                      "unreviewedSuccessful": unreviewed,
                      "plannedQualityCases": quality["planned"] if quality else 0,
                      "strictCompleteRatePlanned": counts["pass"] / quality["planned"] if review and not unreviewed and quality and quality["planned"] else None}
    result = {"schemaVersion": 1, "generatedAt": now(), "runId": run.manifest["runId"],
              "profile": run.manifest["profile"], "datasetHash": run.manifest["datasetHash"],
              "sourceCommit": run.manifest["sourceCommit"], "sourceIdentity": run.manifest["sourceIdentity"],
              "models": run.manifest["models"], "host": run.manifest["host"], "docker": run.manifest["docker"],
              "runtime": read_json(run.root / "runtime-identity.json") if (run.root / "runtime-identity.json").exists() else None,
              "cohorts": cohorts, "qualityReview": review_summary,
              "budget": read_json(run.root / "budget.json") if (run.root / "budget.json").exists() else None}
    metadata_path = run.root / "message-metadata.json"
    if metadata_path.exists():
        result["messageMetadata"] = read_json(metadata_path)
    atomic_json(run.root / "summary.json", result)
    return result


def format_number(value):
    return "—" if value is None else format(value, ".2f")


def write_report(run):
    summary = summarize(run)
    lines = ["# kbchat 基准报告", "", "运行："+summary["runId"]+"；生成："+summary["generatedAt"]+"。",
             "", "模型模式："+summary["profile"]+"。"+
             ("本地替身仅验证协议、状态与测量流程，不代表真实模型效果或延迟。" if summary["profile"] == "fixture" else "使用显式配置的真实模型；结果限于本轮数据和环境。"),
             "", "## 请求结果", "", "| 组 | 计划 | 成功 | 失败 | 未确认 | 未运行 | P50 ms | P95 ms | 首字P95 ms |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for c in summary["cohorts"]:
        lines.append("| "+c["name"]+" | "+" | ".join(str(c[key]) for key in ("planned","succeeded","failed","unknown","notRun"))+
                     " | "+format_number(c["latency"]["p50Ms"])+" | "+format_number(c["latency"]["p95Ms"])+" | "+format_number(c["firstDelta"]["p95Ms"])+" |")
    r = summary["qualityReview"]
    lines += ["", "## 内容审核", "", f'完整通过 {r["pass"]}，部分 {r["partial"]}，失败 {r["fail"]}，成功但待审核 {r["unreviewedSuccessful"]}。',
              "", "审核者："+str(r["reviewer"] or "未提供")+"；方法："+str(r["method"] or "未提供")+"。",
              "", "answered、有效引用编号和锚点覆盖均不等于事实正确。未导入审核时，不生成语义准确率结论。",
              "", "## 检索依据覆盖", "", "| 模式 | 计划正例 | 成功正例 | 完整依据 | 完整/计划 |",
              "| --- | --- | --- | --- | --- |"]
    for c in summary["cohorts"]:
        for mode, v in c.get("retrieval", {}).items():
            lines.append("| "+mode+" | "+str(v["positivePlanned"])+" | "+str(v["positiveSucceeded"])+" | "+str(v["completeEvidence"])+" | "+format_number(v["completeEvidenceRatePlanned"])+" |")
    lines += ["", "vector/hybrid/reranked采用threshold=0比较排名；standard采用0.3。不同模式独立计算分母，某一步失败不会丢弃其他步骤。",
              "", "## 测量边界", "",
              "- P50/P95/P99采用线性插值，仅统计成功请求的有效时延，同时保留失败、未知和未运行分母。",
              "- 首字是首个非空delta，含分类/检索/生成等待；done-only重放没有可测首字，明确为空。",
              "- driverCompletedRps包含创建会话、预算记录、样本落盘和客户端开销；不是服务器最大QPS。中断批次缺少时长时不计算吞吐。",
              "- 向量负载是确定性随机向量、多个预热查询，不代表语义召回率；没有执行计划证据时不宣称使用了HNSW。",
              "- 相同题集重复和并发顺序会影响缓存与远端模型状态。流式轮次交替正反顺序，比较时仍应核对环境。",
              "- 参考事实冻结在dataset.json，不发送给回答模型。质量标签由审核者填写，不由程序写死历史成功数。",
              "", "模型配置："+json.dumps(summary["models"], ensure_ascii=False)+"。", "",
              "原始样本位于cohorts/*/samples，每条原子保存；计划、批次计数、summary.json和审核标签共同构成证据。", ""]
    (run.root / "report.md").write_text("\n".join(lines), encoding="utf-8")
    return summary


def compare(left, right, max_regression=.2):
    reasons = []
    for key in ("profile", "datasetHash", "models", "host"):
        if left[key] != right[key]:
            reasons.append(key + " differs")
    harness = [{k: v for k, v in item.get("sourceIdentity", {}).items() if k.startswith("benchmarks/")}
               for item in (left, right)]
    if harness[0] != harness[1]:
        reasons.append("measurement harness differs")
    # Backend source/image is the intended independent variable. DB/Redis and
    # fixture image, workload configuration and host resources must match.
    for key in ("cpus", "memoryBytes", "serverVersion"):
        if left["docker"][key] != right["docker"][key]:
            reasons.append("docker." + key + " differs")
    if not left.get("runtime") or not right.get("runtime"):
        reasons.append("runtime identity missing")
    else:
        for key in ("postgres", "redis", "fixture"):
            if left["runtime"]["images"].get(key) != right["runtime"]["images"].get(key):
                reasons.append(key + " image differs")
    a = {c["name"]: c for c in left["cohorts"]}
    b = {c["name"]: c for c in right["cohorts"]}
    if set(a) != set(b):
        reasons.append("cohort sets differ")
    rows = []
    for name in sorted(set(a) & set(b)):
        x, y = a[name], b[name]
        # Runtime UUIDs in published chunks differ legitimately; compare content
        # datasetHash and workload instead of the UUID-dependent indexHash.
        configs = [{k: v for k, v in c["config"].items() if k != "indexHash"} for c in (x, y)]
        if configs[0] != configs[1] or x["planned"] != y["planned"] or x.get("taskPlanHash") != y.get("taskPlanHash"):
            reasons.append(name + " workload differs")
        if any(c["unknown"] or c["notRun"] for c in (x, y)):
            reasons.append(name + " incomplete")
        old, new = x["latency"]["p95Ms"], y["latency"]["p95Ms"]
        change = new / old - 1 if old and new is not None else None
        first_old, first_new = x.get("firstDelta", {}).get("p95Ms"), y.get("firstDelta", {}).get("p95Ms")
        first_change = first_new / first_old - 1 if first_old and first_new is not None else None
        rows.append({"name": name, "baselineP95Ms": old, "candidateP95Ms": new,
                     "relativeChange": change, "errorIncrease": y["failed"] > x["failed"],
                     "firstDeltaRelativeChange": first_change,
                     "regression": (change is not None and change > max_regression
                                    or first_change is not None and first_change > max_regression
                                    or y["failed"] > x["failed"])})
    review_change = None
    ar, br = left.get("qualityReview", {}), right.get("qualityReview", {})
    if ar.get("plannedQualityCases") or br.get("plannedQualityCases"):
        if (ar.get("unreviewedSuccessful") or br.get("unreviewedSuccessful")
                or not ar.get("reviewer") or not br.get("reviewer")):
            review_change = {"status": "not_comparable", "reason": "quality labels incomplete"}
            reasons.append("quality labels incomplete")
        else:
            review_change = {"status": "reviewed", "baseline": ar["strictCompleteRatePlanned"],
                             "candidate": br["strictCompleteRatePlanned"],
                             "regression": br["strictCompleteRatePlanned"] < ar["strictCompleteRatePlanned"]}
    return {"compatible": not reasons, "reasons": reasons, "threshold": max_regression,
            "regression": not reasons and (any(row["regression"] for row in rows) or bool(review_change and review_change.get("regression"))),
            "cohorts": rows, "quality": review_change,
            "interpretation": "Observed comparison, not proof of causality or a model accuracy score"}


def export(run, destination):
    """Only explicit public artifacts; never archive the run directory wholesale."""
    from pathlib import Path
    destination = Path(destination).resolve()
    if destination.exists():
        raise BenchError("Export destination exists")
    write_report(run)
    names = ["manifest.json", "dataset.json", "index.json", "runtime-identity.json",
             "summary.json", "report.md", "review.json", "message-metadata.json"]
    paths = [run.root / name for name in names if (run.root / name).is_file()]
    paths += list((run.root / "cohorts").glob("*/plan.json"))
    paths += list((run.root / "cohorts").glob("*/samples/*.json"))
    paths += list((run.root / "cohorts").glob("*/message-metadata.json"))
    # Batch diagnostics are omitted: some deployments may expose private reasons.
    from .runtime import Runtime
    credentials = Runtime(run).credentials()
    values = [credentials[k] for k in ("postgres", "redis", "jwt", "admin")]
    values += [v for k, v in credentials["models"].items() if k.endswith("_API_KEY")]
    for path in paths:
        if path.is_symlink():
            raise BenchError("Refusing symlink in evidence export")
        raw = path.read_bytes()
        if any(len(value) >= 8 and value.encode() in raw for value in values):
            raise BenchError("Configured secret found in export candidate " + path.name)
    manifest = {"runId": run.manifest["runId"],
                "files": [{"path": str(p.relative_to(run.root)), "sha256": file_hash(p)} for p in paths],
                "exclusions": ["private/", "batch diagnostics", "raw container logs"]}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "x", zipfile.ZIP_DEFLATED) as archive:
        for path in paths:
            archive.write(path, path.relative_to(run.root))
        archive.writestr("evidence-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return {"path": str(destination), "sha256": file_hash(destination), "files": len(paths)}
