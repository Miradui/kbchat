"""Immutable run inputs, exclusive operations and durable per-sample records."""
import contextlib
import hashlib
import json
import math
import os
import re
import socket
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import SCHEMA_VERSION

REPO = Path(__file__).resolve().parents[1]
TOOL = REPO / "benchmarks"


class BenchError(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def atomic_json(path, value, private=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600 if private else 0o644)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(canonical(value) + b"\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def source_identity():
    paths = [p for p in (REPO / "backend").rglob("*") if p.is_file()
             and (p.suffix in {".go", ".sql"} or p.name in {"go.mod", "go.sum", "Dockerfile", ".dockerignore"})
             and not any(x in {"bin", "tmp", "uploads", "logs"} for x in p.relative_to(REPO / "backend").parts)]
    paths += list(TOOL.glob("*.py"))
    return {str(p.relative_to(REPO)): file_hash(p) for p in sorted(paths)}


def normalized(text):
    return re.sub(r"\s+", "", text).lower()


def dataset(path):
    root = Path(path).resolve()
    spec = read_json(root / "dataset.json")
    cases = read_json(root / "cases.json")["cases"]
    documents = {}
    hashes = {}
    for doc in spec["documents"]:
        key = doc["key"]
        source = (root / doc["file"]).resolve()
        if not source.is_relative_to(root) or source.suffix != ".md" or source.stat().st_size > 1024 * 1024:
            raise BenchError("Dataset document must be bounded Markdown within its dataset directory")
        if key in documents or doc["group"] not in spec["groups"]:
            raise BenchError("Duplicate document key or unknown group")
        documents[key] = {**doc, "content": source.read_text(encoding="utf-8")}
        hashes[doc["file"]] = file_hash(source)
        if "source" in doc and doc["source"].get("cleanSha256") != hashes[doc["file"]]:
            raise BenchError("Source manifest does not match cleaned document")
    seen = set()
    families = {}
    if not 1 <= len(cases) <= 1000:
        raise BenchError("Dataset must contain 1–1000 cases")
    for case in cases:
        if case["id"] in seen or case["group"] not in spec["groups"] or not case["question"].strip():
            raise BenchError("Duplicate case, unknown group or empty question")
        seen.add(case["id"])
        if "split" in case or "familyId" in case:
            if case.get("split") not in {"dev", "test"} or not isinstance(case.get("familyId"), str) or not case["familyId"]:
                raise BenchError("Split cases require dev/test and a nonempty familyId")
            if families.setdefault(case["familyId"], case["split"]) != case["split"]:
                raise BenchError("A question family cannot cross dev/test splits")
        for unit in case["evidence"]:
            doc = documents.get(unit["doc"])
            if not doc or doc["group"] != case["group"] or not unit["anchors"]:
                raise BenchError("Evidence must refer to a same-group document and contain anchors")
            if not all(normalized(anchor) in normalized(doc["content"]) for anchor in unit["anchors"]):
                raise BenchError("Evidence anchor absent from source for " + case["id"])
    if families and any("split" not in case for case in cases):
        raise BenchError("A split dataset must label every case")
    frozen = {"spec": spec, "cases": cases, "documents": documents, "hashes": hashes}
    return frozen


@contextlib.contextmanager
def exclusive(root):
    """Never auto-delete a stale lock: recovery requires an explicit unlock."""
    path = Path(root) / ".operation.lock"
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise BenchError("Run is locked; wait for the operation or use unlock after its process exits") from None
    with os.fdopen(descriptor, "wb") as output:
        output.write(canonical({"pid": os.getpid(), "host": socket.gethostname(), "startedAt": now()}))
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


class Run:
    def __init__(self, root, check_inputs=False):
        self.root = Path(root).resolve()
        self.manifest = read_json(self.root / "manifest.json")
        if self.manifest.get("schemaVersion") != SCHEMA_VERSION:
            raise BenchError("Unsupported benchmark manifest schema")
        if str(self.root) != self.manifest["runDirectory"]:
            raise BenchError("A live run cannot be moved; reports can be shared with export")
        if check_inputs:
            if self.manifest["sourceIdentity"] != source_identity():
                raise BenchError("Application or harness changed; create a new run instead of mixing results")
            if digest(read_json(self.root / "dataset.json")) != self.manifest["datasetHash"]:
                raise BenchError("Frozen dataset changed; refusing to resume")
        self.data = read_json(self.root / "dataset.json")

    def state(self):
        path = self.root / "state.json"
        return read_json(path) if path.exists() else {"phase": "created", "knowledgeBases": {}, "documents": {}}

    def save_state(self, state):
        atomic_json(self.root / "state.json", state, private=True)

    def cohort(self, name, config, plan):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise BenchError("Invalid cohort name")
        directory = self.root / "cohorts" / name
        directory.mkdir(parents=True, exist_ok=True)
        identity = {"name": name, "config": config, "plan": plan,
                    "runId": self.manifest["runId"], "datasetHash": self.manifest["datasetHash"]}
        identity = json.loads(canonical(identity))
        path = directory / "plan.json"
        if path.exists():
            if read_json(path) != identity:
                raise BenchError("Cohort inputs changed; use a new run")
        else:
            atomic_json(path, identity)
        return Journal(directory)


class Journal:
    """Each record is atomically replaced; an interrupted in-flight sample stays unknown."""
    def __init__(self, root):
        self.root = Path(root)
        self.samples = self.root / "samples"
        self.samples.mkdir(parents=True, exist_ok=True)

    def path(self, key):
        return self.samples / (hashlib.sha256(key.encode()).hexdigest() + ".json")

    def get(self, key):
        path = self.path(key)
        return read_json(path) if path.exists() else None

    def begin(self, key, intent):
        if self.get(key) is not None:
            raise BenchError("Sample already exists; never silently retry a paid or unknown operation")
        record = {"sampleId": key, "state": "in_flight", "startedAt": now(), **intent}
        atomic_json(self.path(key), record)
        return record

    def finish(self, record, result):
        record = {**record, **result, "state": "finished", "finishedAt": now()}
        atomic_json(self.path(record["sampleId"]), record)
        return record

    def rows(self):
        return [read_json(p) for p in sorted(self.samples.glob("*.json"))]


def distribution(values):
    numbers = sorted(float(x) for x in values if x is not None and math.isfinite(x) and x >= 0)
    def quantile(p):
        if not numbers:
            return None
        i = (len(numbers) - 1) * p
        lower, upper = math.floor(i), math.ceil(i)
        return numbers[lower] + (numbers[upper] - numbers[lower]) * (i - lower)
    return {"n": len(numbers), "meanMs": sum(numbers) / len(numbers) if numbers else None,
            "p50Ms": quantile(.5), "p95Ms": quantile(.95), "p99Ms": quantile(.99),
            "maxMs": max(numbers) if numbers else None}


def cache_delta(before, after):
    a, b = before.get("embeddingCache", {}), after.get("embeddingCache", {})
    if not all(key in a and key in b for key in ("hits", "misses", "errors")):
        return None
    result = {key: b[key] - a[key] for key in ("hits", "misses", "errors")}
    if min(result.values()) < 0:
        return {"status": "counter_reset"}
    total = result["hits"] + result["misses"]
    return {**result, "hitRate": result["hits"] / total if total else None}
