"""Seed synthetic data and execute resumable, bounded measurement cohorts."""
import concurrent.futures
import csv
import io
import json
import math
import random
import re
import threading
import time
import uuid

from .runtime import Runtime
from .store import BenchError, Journal, atomic_json, digest, normalized, now, read_json


def sql_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


class Budget:
    """Count top-level calls which may invoke models, not exact Provider calls/tokens."""
    def __init__(self, run):
        self.run = run
        self.path = run.root / "budget.json"
        self.lock = threading.Lock()
        self.value = read_json(self.path) if self.path.exists() else {"reservedRequests": 0}

    def reserve(self):
        with self.lock:
            if self.value["reservedRequests"] >= self.run.manifest["maxModelRequests"]:
                raise BenchError("MODEL_REQUEST_BUDGET_EXHAUSTED")
            self.value["reservedRequests"] += 1
            atomic_json(self.path, self.value, private=True)


def message_metadata(runtime, journal):
    rows = journal.rows()
    ids = [r["clientRequestId"] for r in rows if r.get("clientRequestId")]
    if not ids:
        return
    try:
        result = runtime.sql("SELECT COALESCE(json_agg(json_build_object('clientRequestId',client_request_id,"
                             "'intent',intent,'answerStatus',answer_status,'retrievalQuery',retrieval_query)), '[]'::json)"
                             " FROM chat_messages WHERE role='assistant' AND client_request_id IN (" +
                             ",".join(sql_quote(value) for value in ids) + ");")
        atomic_json(journal.root / "message-metadata.json", {"status": "available", "messages": json.loads(result)})
    except (BenchError, ValueError):
        atomic_json(journal.root / "message-metadata.json", {"status": "unavailable", "messages": []})


def select_cases(run, ids=None):
    cases = run.data["cases"]
    if ids:
        requested = set(ids.split(","))
        cases = [c for c in cases if c["id"] in requested]
        if {c["id"] for c in cases} != requested:
            raise BenchError("Unknown case ID")
    return cases


def evidence(case, items, state, top_k=5):
    if not case["evidence"]:
        return {"applicable": False}
    top = items[:top_k]
    required = {state["documents"][unit["doc"]]["id"] for unit in case["evidence"]}
    covered = []
    for unit in case["evidence"]:
        document_id = state["documents"][unit["doc"]]["id"]
        content = [normalized(item["content"]) for item in top if item["documentId"] == document_id]
        covered.append(all(any(normalized(anchor) in text for text in content) for anchor in unit["anchors"]))
    first = next((i + 1 for i, item in enumerate(top) if item["documentId"] in required), None)
    return {"applicable": True, "completeEvidence": all(covered), "coveredUnits": sum(covered),
            "requiredUnits": len(covered), "documentRecall": len(required & {x["documentId"] for x in top}) / len(required),
            "documentMRR": 1 / first if first else 0}


def seed(run):
    runtime = Runtime(run)
    client = runtime.client()
    state = run.state()
    budget = Budget(run)
    for group, name in run.data["spec"]["groups"].items():
        if group not in state["knowledgeBases"]:
            # Exact marker lets a restart find a create whose response was lost.
            marker = run.manifest["runId"] + ":" + group
            candidates = client.api("GET", "/knowledge-bases?scope=created&pageSize=100")["items"]
            matching = [kb for kb in candidates if kb.get("description") == marker]
            if len(matching) > 1:
                raise BenchError("Ambiguous benchmark knowledge-base creation")
            kb = matching[0] if matching else client.api("POST", "/knowledge-bases",
                {"name": "【基准】" + name, "description": marker, "visibility": "private",
                 "retrievalConfig": {"vectorTopN": 30, "rerankTopK": 5, "scoreThreshold": .3, "enableKeyword": True, "enableRerank": True},
                 "answerConfig": {"answerLanguage": "zh", "allowGeneralKnowledge": False, "temperature": 0}})
            state["knowledgeBases"][group] = kb["id"]
            run.save_state(state)
    for key, document in run.data["documents"].items():
        if key in state["documents"]:
            continue
        kb = state["knowledgeBases"][document["group"]]
        request_id = str(uuid.uuid5(uuid.UUID(run.manifest["runId"]), "upload:" + key))
        receipt = client.api("GET", "/knowledge-bases/" + kb + "/document-uploads/" + request_id)
        if receipt["status"] == "committed":
            response = receipt["document"]
        elif receipt["status"] == "notFound":
            budget.reserve()
            response = client.api("POST", "/knowledge-bases/" + kb + "/documents/text",
                {"requestId": request_id, "title": document["title"], "content": document["content"],
                 "format": "md", "allowDuplicate": False})
        else:
            raise BenchError("Prior upload result is no longer available")
        state["documents"][key] = {"id": response["id"], "requestId": request_id, "group": document["group"]}
        run.save_state(state)
    deadline = time.monotonic() + 600
    while True:
        pending = 0
        for document in state["documents"].values():
            response = client.api("GET", "/documents/" + document["id"])
            if response["status"] == "failed" and response.get("jobStatus") == "failed":
                raise BenchError("Document processing failed: " + str(response.get("errorCode")))
            pending += response["status"] != "completed"
        if not pending:
            break
        if time.monotonic() >= deadline:
            raise BenchError("Document processing deadline exceeded; state saved")
        time.sleep(.5)
    chunks = []
    for doc in state["documents"].values():
        page = 1
        while True:
            response = client.api("GET", "/documents/" + doc["id"] + "/chunks?pageSize=100&page=" + str(page))
            chunks += [{"documentId": doc["id"], **item} for item in response["items"]]
            if not response["items"] or page * 100 >= response.get("total", len(response["items"])):
                break
            page += 1
    unavailable = [case["id"] for case in run.data["cases"]
                   if case["evidence"] and not evidence(case, chunks, state, len(chunks))["completeEvidence"]]
    snapshot = {"chunks": chunks, "unavailableEvidenceCases": unavailable}
    atomic_json(run.root / "index.json", snapshot)
    state["seeded"] = True
    state["indexHash"] = digest(chunks)
    run.save_state(state)
    emit("seeded", documents=len(state["documents"]), chunks=len(chunks), unavailableEvidenceCases=unavailable)
    if unavailable:
        raise BenchError("Gold evidence is missing from published chunks; retain finding before evaluation")


def context(run, timeout):
    state = run.state()
    if not state.get("seeded"):
        raise BenchError("Run seed before measuring")
    runtime = Runtime(run)
    return runtime, runtime.client(timeout), state


def corpus_context(run):
    state = run.state()
    return {"qualityDatasetHash": run.manifest["datasetHash"],
            "syntheticCounts": sorted(int(key) for key, value in state.get("synthetic", {}).items() if value.get("complete"))}


def measure(run, name, config, tasks, execute, concurrency=1, timeout=120, warmup=None):
    runtime, client, state = context(run, timeout)
    journal = run.cohort(name, config, [{"id": task["id"], **task} for task in tasks])
    pending = [task for task in tasks if journal.get(task["id"]) is None]
    if not pending:
        if config["suite"] in {"quality", "stream"}:
            message_metadata(runtime, journal)
        emit("cohort_retained", name=name, samples=len(journal.rows()))
        return
    budget = Budget(run)
    if warmup:
        warmup(client, budget)
    try:
        before = client.api("GET", "/system/diagnostics")
    except BenchError:
        before = {}
    batch_id = uuid.uuid4().hex
    start_wall, started = now(), time.perf_counter()
    abort = threading.Event()
    failure_lock = threading.Lock()
    failures = 0
    def one(task):
        nonlocal failures
        if abort.is_set():
            return
        record = journal.begin(task["id"], {"task": task, "batchId": batch_id})
        try:
            result = execute(client, state, budget, task, journal, record)
        except Exception as error:
            result = {"ok": False, "errorCode": str(error) if isinstance(error, BenchError) else type(error).__name__,
                      "totalMs": None}
        journal.finish(record, result)
        with failure_lock:
            failures += not result["ok"]
            if failures >= 3 and config["suite"] in {"quality", "stream"}:
                abort.set()
    emit("cohort_start", name=name, pending=len(pending), concurrency=concurrency)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            list(pool.map(one, pending))
    finally:
        elapsed = time.perf_counter() - started
        try:
            after = client.api("GET", "/system/diagnostics")
        except BenchError:
            after = {}
        atomic_json(journal.root / ("batch-" + batch_id + ".json"),
                    {"id": batch_id, "startedAt": start_wall, "endedAt": now(), "wallSeconds": elapsed,
                     "before": before, "after": after, "abortedAfterFailures": abort.is_set()})
    emit("cohort_complete", name=name, recorded=len(journal.rows()), failures=failures)
    if config["suite"] in {"quality", "stream"}:
        message_metadata(runtime, journal)


def retrieval(run, cases, timeout=120):
    tasks = []
    modes = {"vector": (False, False, 0), "hybrid": (True, False, 0),
             "reranked": (True, True, 0), "standard": (True, True, .3)}
    for case in cases:
        order = list(modes)
        random.Random(case["id"]).shuffle(order)
        tasks += [{"id": case["id"] + "-" + mode, "caseId": case["id"], "mode": mode} for mode in order]
    by_id = {case["id"]: case for case in cases}
    config = {"suite": "retrieval", "topN": 30, "topK": 5, "modes": modes, "timeout": timeout,
              "query": "original question", "cache": "prewarmed", "indexHash": run.state()["indexHash"],
              "corpus": corpus_context(run)}
    def warmup(client, budget):
        state = run.state()
        for case in cases:
            budget.reserve()
            client.api("POST", "/knowledge-bases/" + state["knowledgeBases"][case["group"]] + "/search",
                       {"query": case["question"], "enableKeyword": False, "enableRerank": False, "scoreThreshold": 0})
    def execute(client, state, budget, task, *_):
        case = by_id[task["caseId"]]
        keyword, rerank, threshold = modes[task["mode"]]
        budget.reserve()
        result = client.exchange("POST", "/knowledge-bases/" + state["knowledgeBases"][case["group"]] + "/search",
            {"query": case["question"], "debug": True, "vectorTopN": 30, "rerankTopK": 5,
             "scoreThreshold": threshold, "enableKeyword": keyword, "enableRerank": rerank})
        if result["ok"]:
            payload = result["body"]
            if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
                result.update(ok=False, errorCode="INVALID_SEARCH_RESULT")
            else:
                result["evidence"] = evidence(case, payload["items"], state)
        return result
    measure(run, "retrieval", config, tasks, execute, timeout=timeout, warmup=warmup)


def chat_executor(run, by_id):
    def execute(client, state, budget, task, journal, record):
        case = by_id[task["caseId"]]
        session = client.api("POST", "/chat/sessions", {"knowledgeBaseId": state["knowledgeBases"][case["group"]]})
        request_id = str(uuid.uuid5(uuid.UUID(run.manifest["runId"]), journal.root.name + ":" + task["id"]))
        # Persist identifiers before spending on a generation. Unknown operations
        # can later be reconciled without automatically calling the model again.
        record.update(sessionId=session["id"], clientRequestId=request_id)
        atomic_json(journal.path(task["id"]), record)
        budget.reserve()
        result = client.stream(session["id"], case["question"], request_id)
        if result["ok"]:
            tags = [int(n) for n in re.findall(r"\[source:\s*(\d+)\]", result["answer"])]
            result["checks"] = {"evidence": evidence(case, result["citations"], state),
                                "sourceIndexesValid": all(1 <= n <= len(result["citations"]) for n in tags),
                                "hasInlineCitation": bool(tags), "semanticReview": "pending"}
        return result
    return execute


def quality(run, cases, timeout=120):
    tasks = [{"id": case["id"], "caseId": case["id"]} for case in cases]
    measure(run, "quality", {"suite": "quality", "threshold": .3, "history": "fresh session",
                            "temperature": 0, "timeout": timeout, "indexHash": run.state()["indexHash"],
                            "corpus": corpus_context(run)},
            tasks, chat_executor(run, {case["id"]: case for case in cases}), timeout=timeout)


def stream(run, cases, requests, concurrency, rounds, timeout=120):
    by_id = {case["id"]: case for case in cases}
    for round_index in range(rounds):
        order = concurrency if round_index % 2 == 0 else list(reversed(concurrency))
        for count in order:
            tasks = [{"id": str(i), "caseId": cases[i % len(cases)]["id"]} for i in range(requests)]
            measure(run, "stream-r" + str(round_index + 1) + "-c" + str(count),
                    {"suite": "stream", "round": round_index + 1, "concurrency": count, "requests": requests,
                     "threshold": .3, "cache": "natural", "history": "fresh session", "temperature": 0,
                     "timeout": timeout, "indexHash": run.state()["indexHash"], "corpus": corpus_context(run)},
                    tasks, chat_executor(run, by_id), concurrency=count, timeout=timeout)


def synthetic(run, count):
    runtime, client, state = context(run, 120)
    key = str(count)
    inventories = state.setdefault("synthetic", {})
    if key in inventories and inventories[key].get("complete"):
        return inventories[key]
    marker = run.manifest["runId"] + ":vectors:" + key
    if key not in inventories:
        candidates = client.api("GET", "/knowledge-bases?scope=created&pageSize=100")["items"]
        matching = [kb for kb in candidates if kb.get("description") == marker]
        if len(matching) > 1:
            raise BenchError("Ambiguous synthetic knowledge base")
        kb = matching[0] if matching else client.api("POST", "/knowledge-bases",
             {"name": "【基准】合成向量" + key, "description": marker, "visibility": "private"})
        inventories[key] = {"id": kb["id"], "complete": False}
        run.save_state(state)
    kb_id = inventories[key]["id"]
    existing = int(runtime.sql("SELECT count(*) FROM document_chunks WHERE knowledge_base_id=" + sql_quote(kb_id) + ";"))
    dimension = int(run.manifest["models"]["EMBEDDING_DIMENSION"])
    namespace = uuid.uuid5(uuid.UUID(run.manifest["runId"]), "vectors:" + key)
    if existing not in (0, count):
        raise BenchError("Unexpected partial synthetic corpus")
    if existing == 0:
        owner = client.api("GET", "/auth/me")["id"]
        output = io.StringIO()
        output.write("BEGIN;\n")
        for index in range((count + 9) // 10):
            doc = str(uuid.uuid5(namespace, "doc:" + str(index)))
            values = [sql_quote(doc), sql_quote(kb_id), sql_quote(owner), sql_quote("synthetic-" + str(index)),
                      "'txt'", "'synthetic/" + doc + "'", "'completed'", "'synthetic-v1'", str(dimension)]
            output.write("INSERT INTO documents(id,knowledge_base_id,uploader_id,filename,file_type,storage_path,status,embedding_model,embedding_dimension) VALUES(" + ",".join(values) + ");\n")
        output.write("COPY document_chunks(id,document_id,knowledge_base_id,chunk_index,content,token_count,metadata,embedding,search_vector) FROM STDIN WITH(FORMAT csv);\n")
        writer = csv.writer(output, lineterminator="\n")
        rng = random.Random(20261121)
        for index in range(count):
            values = [rng.uniform(-1, 1) for _ in range(dimension)]
            length = math.sqrt(sum(value * value for value in values))
            vector = "[" + ",".join(format(value / length, ".8f") for value in values) + "]"
            writer.writerow([str(uuid.uuid5(namespace, "chunk:" + str(index))),
                             str(uuid.uuid5(namespace, "doc:" + str(index // 10))), kb_id, index % 10,
                             "Synthetic capacity item " + str(index), 16, '{"source":"benchmark_synthetic"}',
                             vector, "'synthetic':1"])
        output.write("\\.\nANALYZE document_chunks; ANALYZE documents; COMMIT;\n")
        runtime.sql(output.getvalue())
    inventories[key].update(complete=True, count=count, dimension=dimension, seed=20261121)
    run.save_state(state)
    return inventories[key]


def load(run, counts, requests, concurrency, timeout=60):
    all_counts = set(counts) | {int(key) for key in run.state().get("synthetic", {})}
    if sum(all_counts) * int(run.manifest["models"]["EMBEDDING_DIMENSION"]) > 25_000_000:
        raise BenchError("Synthetic corpus budget exceeds 25 million vector components; reduce sizes")
    # Seed every size first: all cohorts in the run share a known global table.
    corpora = {count: synthetic(run, count) for count in counts}
    queries = ["合成向量基准查询" + str(i) for i in range(16)]
    for count, corpus in corpora.items():
        for endpoint in ("documents", "vector"):
            for parallel in concurrency:
                tasks = [{"id": str(i), "queryIndex": i % len(queries)} for i in range(requests)]
                def execute(client, state, budget, task, *_):
                    if endpoint == "documents":
                        result = client.exchange("GET", "/documents?knowledgeBaseId=" + corpus["id"] + "&pageSize=20")
                    else:
                        budget.reserve()
                        result = client.exchange("POST", "/knowledge-bases/" + corpus["id"] + "/search",
                            {"query": queries[task["queryIndex"]], "vectorTopN": 30, "rerankTopK": 5,
                             "scoreThreshold": 0, "enableKeyword": False, "enableRerank": False})
                    if result["ok"]:
                        body = result.pop("body")
                        valid = isinstance(body, dict) and isinstance(body.get("items"), list) and bool(body["items"])
                        result.update(ok=valid, returned=len(body["items"]) if valid else 0,
                                      errorCode=None if valid else "INVALID_RESULT")
                    return result
                def warmup(client, budget):
                    if endpoint == "vector":
                        for query in queries:
                            budget.reserve()
                            client.api("POST", "/knowledge-bases/" + corpus["id"] + "/search",
                                {"query": query, "scoreThreshold": 0, "enableKeyword": False, "enableRerank": False})
                measure(run, endpoint + "-n" + str(count) + "-c" + str(parallel),
                        {"suite": "load", "endpoint": endpoint, "vectors": count, "dimension": corpus["dimension"],
                         "globalSyntheticVectors": sum(all_counts), "queries": queries, "concurrency": parallel,
                         "requests": requests, "timeout": timeout, "cache": "prewarmed", "rerank": False,
                         "keyword": False, "threshold": 0, "seed": 20261121, "corpus": corpus_context(run)},
                        tasks, execute, concurrency=parallel, timeout=timeout, warmup=warmup)


def reconcile(run):
    runtime, client, _ = context(run, 120)
    recovered = 0
    for cohort in (run.root / "cohorts").glob("*"):
        journal = Journal(cohort)
        for row in journal.rows():
            if row["state"] == "finished" or not row.get("sessionId"):
                continue
            response = client.api("GET", "/chat/sessions/" + row["sessionId"] + "/messages")
            messages = [m for m in response["items"] if m.get("clientRequestId") == row["clientRequestId"]]
            assistants = [m for m in messages if m["role"] == "assistant"]
            if len(messages) == 2 and len(assistants) == 1:
                assistant = assistants[0]
                journal.finish(row, {"ok": True, "reconciled": True, "totalMs": None,
                                     "firstDeltaMs": None, "answer": assistant["content"],
                                     "citations": assistant.get("citations", []),
                                     "answerStatus": assistant.get("answerStatus")})
                recovered += 1
    emit("reconciled", recovered=recovered, note="Unknown or failed samples are never automatically regenerated")
