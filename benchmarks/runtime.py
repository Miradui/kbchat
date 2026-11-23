"""Managed Docker resources only; no arbitrary database/API target flags."""
import json
import os
import platform
import secrets
import shlex
import shutil
import subprocess
import time
import urllib.parse
import uuid
from pathlib import Path

from .client import Client
from .store import (BenchError, REPO, TOOL, Run, atomic_json, dataset, digest,
                    file_hash, now, read_json, source_identity)

LABEL = "io.kbchat.benchmark.run"
MODEL_KEYS = {prefix + suffix for prefix in ("CHAT", "EMBEDDING", "RERANK")
              for suffix in ("_BASE_URL", "_API_KEY", "_MODEL")} | {"EMBEDDING_DIMENSION"}


def clean_env():
    # Docker may need its credential helper and local socket location. No Compose,
    # application, test, proxy or alternate daemon variables are inherited.
    return {k: v for k, v in os.environ.items()
            if k in {"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
                     "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"}}


def models(path, profile):
    if profile == "fixture":
        return {**{p + "_BASE_URL": "http://fixture:8089/v1" for p in ("CHAT", "EMBEDDING", "RERANK")},
                **{p + "_API_KEY": "fixture-key" for p in ("CHAT", "EMBEDDING", "RERANK")},
                **{p + "_MODEL": "fixture-" + p.lower() for p in ("CHAT", "EMBEDDING", "RERANK")},
                "EMBEDDING_DIMENSION": "64"}
    if not path:
        raise BenchError("Real profile requires an explicit --models-env file")
    values = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise BenchError("Model file requires KEY=value lines")
        key, raw = line.split("=", 1)
        key = key.strip()
        if key not in MODEL_KEYS or key in values:
            raise BenchError("Unknown or duplicate model configuration key: " + key)
        parts = shlex.split(raw, comments=True)
        if len(parts) != 1 or "\n" in parts[0]:
            raise BenchError("Model values must be single literal values; quote spaces")
        values[key] = parts[0]
    if set(values) != MODEL_KEYS:
        raise BenchError("Provide all CHAT/EMBEDDING/RERANK URL, key, model fields and EMBEDDING_DIMENSION")
    try:
        dimension = int(values["EMBEDDING_DIMENSION"])
    except ValueError:
        raise BenchError("Embedding dimension must be an integer") from None
    if not 1 <= dimension <= 2000:
        raise BenchError("Embedding dimension must be 1–2000 for this HNSW fixture")
    for key in ("CHAT_BASE_URL", "EMBEDDING_BASE_URL", "RERANK_BASE_URL"):
        url = urllib.parse.urlsplit(values[key])
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise BenchError("Model endpoints must be HTTP(S), without credentials, query or fragment")
        if url.hostname in {"localhost", "127.0.0.1", "::1"}:
            raise BenchError("Models run outside the container: use host.docker.internal for host services")
    return values


def docker_call(context, args, stdin=None, timeout=120):
    try:
        result = subprocess.run(["docker", "--context", context, *args], env=clean_env(),
                                input=stdin, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BenchError("Docker operation failed: " + type(error).__name__) from None
    return result


def discover_docker():
    result = subprocess.run(["docker", "context", "show"], env=clean_env(), capture_output=True, text=True)
    if result.returncode:
        raise BenchError("Docker is unavailable")
    context = result.stdout.strip()
    inspect = docker_call(context, ["context", "inspect", context])
    if inspect.returncode:
        raise BenchError("Cannot inspect the current Docker context")
    endpoint = json.loads(inspect.stdout)[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith(("unix://", "npipe://")):
        raise BenchError("Benchmark requires a local Docker daemon")
    info = docker_call(context, ["info", "--format", "{{json .}}"])
    if info.returncode:
        raise BenchError("Docker daemon is not ready")
    payload = json.loads(info.stdout)
    return context, {"id": payload["ID"], "cpus": payload["NCPU"], "memoryBytes": payload["MemTotal"],
                     "serverVersion": payload["ServerVersion"], "os": payload["OperatingSystem"]}


def compose_spec(root, project, token, model_config, password, redis_password, jwt, admin, profile):
    environment = {
        "APP_ENV": "production", "SERVER_PORT": "8080", "RAG_ALLOW_AUTOMIGRATE": "false",
        "DATABASE_URL": "postgres://benchmark:" + password + "@postgres:5432/benchmark?sslmode=disable",
        "REDIS_ADDR": "redis:6379", "REDIS_PASSWORD": redis_password, "REDIS_DB": "0",
        "JWT_SECRET": jwt, "BOOTSTRAP_ADMIN_PASSWORD": admin, "BOOTSTRAP_ADMIN_DISPLAY_NAME": "Benchmark",
        "STORAGE_PROVIDER": "local", "UPLOAD_DIR": "/app/uploads",
        "MINIO_ENDPOINT": "", "MINIO_ACCESS_KEY": "", "MINIO_SECRET_KEY": "", "MINIO_BUCKET": "",
        "MINIO_REGION": "", "MINIO_USE_SSL": "false", "PDF_OCR_ENABLED": "false",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "",
        "MODEL_PROVIDER": "openai_compatible", "OPENAI_API_KEY": "", "OPENAI_BASE_URL": "",
        "RERANK_ENABLED": "true", "RERANK_FAILURE_MODE": "strict", "KEYWORD_SEARCH_ENABLED": "true",
        "CHAT_HISTORY_LIMIT": "10", "CHAT_ALLOWED_MODELS": "", "MODEL_PRICING": "{}",
        "RATE_LIMIT_ENABLED": "true", "RATE_LIMIT_LOGIN_PER_MINUTE": "10000",
        "RATE_LIMIT_CHAT_PER_MINUTE": "10000", "RATE_LIMIT_FAILURE_MODE": "closed",
        "EMBEDDING_CACHE_TTL": "24h", "WORKER_CONCURRENCY": "2", "WORKER_MAX_RETRIES": "3",
        "WORKER_RETRY_DELAY": "10s", "VECTOR_TOP_N": "30", "RERANK_TOP_K": "5", "SCORE_THRESHOLD": "0.3",
        "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "", "NO_PROXY": "*", **model_config,
    }
    environment = {key: value.replace("$", "$$") for key, value in environment.items()}
    labels = {LABEL: token}
    services = {
        "postgres": {"image": "pgvector/pgvector:pg16", "labels": labels,
                     "environment": {"POSTGRES_USER": "benchmark", "POSTGRES_DB": "benchmark", "POSTGRES_PASSWORD": password},
                     "volumes": ["postgres_data:/var/lib/postgresql/data"],
                     "healthcheck": {"test": ["CMD", "pg_isready", "-U", "benchmark", "-d", "benchmark"], "interval": "1s", "timeout": "3s", "retries": 60}},
        "redis": {"image": "redis:7-alpine", "labels": labels, "environment": {"REDIS_PASSWORD": redis_password},
                  "volumes": ["redis_data:/data"],
                  "command": ["sh", "-c", 'exec redis-server --requirepass "$$REDIS_PASSWORD"'],
                  "healthcheck": {"test": ["CMD-SHELL", 'REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping'], "interval": "1s", "timeout": "3s", "retries": 60}},
        "backend": {"image": project + "-backend", "build": {"context": str(REPO / "backend")},
                    "labels": labels, "init": True, "stop_grace_period": "35s", "environment": environment,
                    "ports": [{"target": 8080, "published": "0", "host_ip": "127.0.0.1"}],
                    "volumes": ["uploads:/app/uploads"], "tmpfs": ["/tmp:size=512m,mode=1777"], "read_only": True,
                    "security_opt": ["no-new-privileges:true"], "cap_drop": ["ALL"],
                    "extra_hosts": ["host.docker.internal:host-gateway"],
                    "healthcheck": {"test": ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/healthz | jq -e '.status == \"ok\"' >/dev/null"], "interval": "1s", "timeout": "3s", "retries": 60},
                    "depends_on": {"postgres": {"condition": "service_healthy"}, "redis": {"condition": "service_healthy"}}},
    }
    if profile == "fixture":
        services["fixture"] = {"image": "python:3.13-alpine", "labels": labels,
                               "command": ["python", "/fixture.py"], "environment": {"FIXTURE_DIMENSION": "64"},
                               "volumes": [str(root / "private" / "fixture.py") + ":/fixture.py:ro"],
                               "read_only": True, "security_opt": ["no-new-privileges:true"]}
        services["backend"]["depends_on"]["fixture"] = {"condition": "service_started"}
    return {"name": project, "services": services,
            "networks": {"default": {"labels": labels}},
            "volumes": {"postgres_data": {"labels": labels}, "redis_data": {"labels": labels}, "uploads": {"labels": labels}}}


def create(root, profile, model_file, dataset_path, max_calls):
    root = Path(root).resolve()
    if root.exists():
        raise BenchError("Run directory already exists; choose a fresh directory")
    model_config = models(model_file, profile)
    frozen = dataset(dataset_path)
    context, daemon = discover_docker()
    token = uuid.uuid4().hex
    project = "kbchat-bench-" + token[:12]
    root.mkdir(parents=True, mode=0o700)
    (root / "private").mkdir(mode=0o700)
    credentials = {"postgres": secrets.token_hex(24), "redis": secrets.token_hex(24),
                   "jwt": secrets.token_hex(32), "admin": secrets.token_hex(24), "models": model_config}
    atomic_json(root / "private" / "credentials.json", credentials, private=True)
    shutil.copyfile(TOOL / "fixture.py", root / "private" / "fixture.py")
    spec = compose_spec(root, project, token, model_config, credentials["postgres"],
                        credentials["redis"], credentials["jwt"], credentials["admin"], profile)
    atomic_json(root / "private" / "compose.json", spec, private=True)
    atomic_json(root / "dataset.json", frozen)
    (root / "private" / "empty.env").write_text("")
    git = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True)
    manifest = {"schemaVersion": 1, "runId": token, "project": project, "runDirectory": str(root),
                "createdAt": now(), "profile": profile, "sourceIdentity": source_identity(),
                "sourceCommit": git.stdout.strip(), "datasetHash": digest(frozen),
                "models": {k: v for k, v in model_config.items() if not k.endswith("_API_KEY")},
                "credentialHash": file_hash(root / "private" / "credentials.json"),
                "composeHash": file_hash(root / "private" / "compose.json"),
                "fixtureHash": file_hash(root / "private" / "fixture.py"),
                "dockerContext": context, "docker": daemon,
                "host": {"platform": platform.platform(), "machine": platform.machine(), "cpuCount": os.cpu_count()},
                "maxModelRequests": max_calls, "timer": "HTTP request through first nonempty delta/done; new connection",
                "rateLimit": 10000, "otlp": False}
    atomic_json(root / "manifest.json", manifest)
    return Run(root)


class Runtime:
    def __init__(self, run):
        self.run = run
        self.root, self.m = run.root, run.manifest

    def credentials(self):
        path = self.root / "private" / "credentials.json"
        if file_hash(path) != self.m["credentialHash"]:
            raise BenchError("Run credentials or model configuration changed")
        return read_json(path)

    def check_private(self):
        self.credentials()
        for name, key in (("compose.json", "composeHash"), ("fixture.py", "fixtureHash")):
            if file_hash(self.root / "private" / name) != self.m[key]:
                raise BenchError("Runtime definition changed; refusing mutation")

    def docker(self, args, stdin=None, timeout=120, required=True):
        result = docker_call(self.m["dockerContext"], args, stdin, timeout)
        if required and result.returncode:
            # Provider/daemon errors can contain environment values. Keep logs private.
            with (self.root / "private" / "docker-errors.log").open("ab") as out:
                out.write(result.stderr + b"\n")
            raise BenchError("Docker command failed; details retained in private/docker-errors.log")
        return result

    def compose(self, args, stdin=None, timeout=120):
        self.check_private()
        command = ["compose", "--project-name", self.m["project"], "--env-file",
                   str(self.root / "private" / "empty.env"), "-f", str(self.root / "private" / "compose.json"), *args]
        return self.docker(command, stdin, timeout)

    def guard(self):
        """Revalidate daemon and every discovered resource before each operation."""
        self.check_private()
        daemon = self.docker(["info", "--format", "{{.ID}}"]).stdout.decode().strip()
        if daemon != self.m["docker"]["id"]:
            raise BenchError("Docker daemon identity changed")
        project = self.m["project"]
        for kind, listing in (("container", ["ps", "-a", "-q"]), ("volume", ["volume", "ls", "-q"]),
                              ("network", ["network", "ls", "-q"])):
            names = set(self.docker([*listing, "--filter", "label=com.docker.compose.project=" + project]).stdout.decode().split())
            expected = ({"%s-%s-1" % (project, service) for service in ("backend", "postgres", "redis", "fixture")}
                        if kind == "container" else {project + "_" + suffix for suffix in
                            (("postgres_data", "redis_data", "uploads") if kind == "volume" else ("default",))})
            # Compose can reuse an existing named volume/network even without a
            # project label. Inspect those names too before creating or removing.
            all_names = self.docker(["ps", "-a", "--format", "{{.Names}}"] if kind == "container" else
                                    [kind, "ls", "--format", "{{.Name}}"]).stdout.decode().split()
            names.update(expected & set(all_names))
            for name in names:
                inspect = ["inspect", name] if kind == "container" else [kind, "inspect", name]
                data = json.loads(self.docker(inspect).stdout)[0]
                labels = (data.get("Config", {}).get("Labels") if kind == "container" else data.get("Labels")) or {}
                if labels.get(LABEL) != self.m["runId"] or labels.get("com.docker.compose.project") != project:
                    raise BenchError("Resource ownership mismatch; refusing operation")
                if kind == "container":
                    for mount in data.get("Mounts", []):
                        if mount["Type"] == "volume":
                            volume = json.loads(self.docker(["volume", "inspect", mount["Name"]]).stdout)[0]
                            if (volume.get("Labels") or {}).get(LABEL) != self.m["runId"]:
                                raise BenchError("Mounted volume ownership mismatch")

    def service(self, name):
        ids = self.compose(["ps", "-a", "-q", name]).stdout.decode().split()
        if len(ids) != 1:
            raise BenchError("Expected exactly one managed " + name + " container")
        return json.loads(self.docker(["inspect", ids[0]]).stdout)[0]

    def sql(self, statement):
        self.guard()
        return self.compose(["exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1",
                             "-U", "benchmark", "-d", "benchmark", "-At"], statement.encode(), 300).stdout.decode().strip()

    def initialize_schema(self):
        migrations = sorted((REPO / "backend/migrations").glob("*.sql"))
        identity = digest({"files": {p.name: file_hash(p) for p in migrations},
                           "dimension": self.m["models"]["EMBEDDING_DIMENSION"]})
        exists = self.sql("SELECT to_regclass('kbchat_benchmark.identity') IS NOT NULL;")
        if exists == "t":
            found = self.sql("SELECT run_id || ':' || input_hash FROM kbchat_benchmark.identity;")
            if found != self.m["runId"] + ":" + identity:
                raise BenchError("Database initialization marker belongs to different inputs")
            return
        if self.sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';") != "0":
            raise BenchError("Initialization requires a completely empty public schema")
        dimension = int(self.m["models"]["EMBEDDING_DIMENSION"])
        # All empty-fixture migrations, dimension setup and marker are committed
        # together. A lost commit response is resolved by the marker on resume.
        statements = ["BEGIN; SET LOCAL statement_timeout='240s';"]
        statements += [p.read_text(encoding="utf-8") for p in migrations]
        statements += ["LOCK TABLE document_chunks IN ACCESS EXCLUSIVE MODE;",
                       "DO $$ BEGIN IF EXISTS(SELECT 1 FROM document_chunks) THEN RAISE EXCEPTION 'nonempty vectors'; END IF; END $$;",
                       "DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;",
                       "ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(" + str(dimension) + ");",
                       "CREATE INDEX idx_chunks_embedding_hnsw ON document_chunks USING hnsw(embedding vector_cosine_ops) WITH(m=16,ef_construction=64);",
                       "CREATE SCHEMA kbchat_benchmark;",
                       "CREATE TABLE kbchat_benchmark.identity(run_id text PRIMARY KEY,input_hash text NOT NULL);",
                       "INSERT INTO kbchat_benchmark.identity VALUES('" + self.m["runId"] + "','" + identity + "');", "COMMIT;"]
        self.sql("\n".join(statements))

    def verify_images(self, create=False):
        identity = {"images": {s: self.service(s)["Image"] for s in ["backend", "postgres", "redis"] +
                              (["fixture"] if self.m["profile"] == "fixture" else [])},
                    "dimension": int(self.m["models"]["EMBEDDING_DIMENSION"])}
        path = self.root / "runtime-identity.json"
        if path.exists():
            if read_json(path) != identity:
                raise BenchError("Runtime images changed; create a new run")
        elif create:
            atomic_json(path, identity)
        else:
            raise BenchError("Runtime identity is missing")

    def up(self):
        self.guard()
        state = self.run.state()
        if state["phase"] == "removed":
            raise BenchError("Removed run cannot be resumed")
        if not state.get("initialized"):
            self.compose(["build", "backend"], timeout=1200)
            self.compose(["up", "-d", "--wait", "postgres", "redis"], timeout=120)
            self.initialize_schema()
            self.compose(["run", "--rm", "--no-deps", "backend", "/app/bin/rag-bootstrap-admin", "-username", "benchmark", "-create"])
            state["phase"] = "initialized"
            state["initialized"] = True
            self.run.save_state(state)
        services = ["backend"] + (["fixture"] if self.m["profile"] == "fixture" else [])
        self.compose(["up", "-d", "--wait", *services], timeout=120)
        self.guard()
        self.verify_images(create=True)
        api = self.service("backend")
        ports = api["NetworkSettings"]["Ports"]["8080/tcp"]
        if len(ports) != 1 or ports[0]["HostIp"] != "127.0.0.1":
            raise BenchError("API must be published only on loopback")
        state.update({"phase": "running", "api": "http://127.0.0.1:" + ports[0]["HostPort"] + "/api/v1"})
        self.run.save_state(state)
        self.guard()
        self.client().api("GET", "/healthz")

    def client(self, timeout=120):
        self.guard()
        state = self.run.state()
        if state["phase"] != "running":
            raise BenchError("Managed runtime is not running; use up")
        self.verify_images()
        api = self.service("backend")
        ports = api["NetworkSettings"]["Ports"].get("8080/tcp", [])
        if len(ports) != 1 or ports[0]["HostIp"] != "127.0.0.1" or state["api"] != "http://127.0.0.1:" + ports[0]["HostPort"] + "/api/v1":
            raise BenchError("API endpoint no longer matches owned container")
        client = Client(state["api"], timeout)
        client.login(self.credentials()["admin"])
        return client

    def down(self, remove=False):
        self.guard()
        self.compose(["down", "--volumes"] if remove else ["stop"], timeout=90)
        remaining = self.docker(["ps", "-q", "--filter", "label=com.docker.compose.project=" + self.m["project"]]).stdout.decode().split()
        if remaining:
            raise BenchError("Benchmark containers have not stopped")
        if remove:
            volumes = self.docker(["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + self.m["project"]]).stdout.decode().split()
            if volumes:
                raise BenchError("Benchmark volumes were not removed")
        state = self.run.state()
        state["phase"] = "removed" if remove else "stopped"
        self.run.save_state(state)
