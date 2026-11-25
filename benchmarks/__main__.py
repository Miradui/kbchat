import argparse
import json
import os
import socket
import sys
from pathlib import Path

from .evals import evaluate, write_evals
from .report import compare, export, import_review, review_template, write_report
from .runner import load, quality, reconcile, retrieval, seed, select_cases, stream
from .runtime import Runtime, create
from .store import BenchError, Run, TOOL, atomic_json, exclusive, read_json


def positive(value):
    try:
        result = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("positive integer required") from None
    if not 1 <= result <= 100000:
        raise argparse.ArgumentTypeError("integer must be 1–100000")
    return result


def counts(value):
    try:
        result = [positive(v) for v in value.split(",")]
    except argparse.ArgumentTypeError:
        raise argparse.ArgumentTypeError("comma-separated positive integers required") from None
    if len(set(result)) != len(result):
        raise argparse.ArgumentTypeError("duplicate values are not allowed")
    return result


def parser():
    root = argparse.ArgumentParser(description="Isolated kbchat performance and quality benchmarks")
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("init", "up", "seed", "run", "report", "review", "reconcile", "down", "unlock", "smoke", "export", "evals"):
        child = commands.add_parser(name)
        child.add_argument("--run", required=True, type=Path)
        if name in {"init", "smoke"}:
            child.add_argument("--profile", choices=["fixture", "real"], default="fixture")
            child.add_argument("--models-env", type=Path)
            child.add_argument("--dataset", type=Path, default=TOOL / "datasets/demo")
            child.add_argument("--max-model-requests", type=positive, default=500)
        if name == "run":
            child.add_argument("--suite", choices=["retrieval", "quality", "stream", "load"], required=True)
            child.add_argument("--case-ids")
            child.add_argument("--requests", type=positive, default=20)
            child.add_argument("--concurrency", type=counts, default=[1, 2, 4])
            child.add_argument("--rounds", type=positive, default=2)
            child.add_argument("--vectors", type=counts, default=[1000, 10000])
            child.add_argument("--timeout", type=positive, default=120)
        if name == "review":
            child.add_argument("--import", dest="import_path", type=Path)
        if name == "evals":
            child.add_argument("--baseline", type=Path, help="Optional prior run for descriptive metric deltas; no quality gate")
        if name == "down":
            child.add_argument("--remove-volumes", action="store_true")
        if name == "export":
            child.add_argument("--output", type=Path, required=True)
    comp = commands.add_parser("compare")
    comp.add_argument("baseline", type=Path)
    comp.add_argument("candidate", type=Path)
    comp.add_argument("--max-regression", type=float, default=.2)
    return root


def measured_exit(summary, suite):
    selected = [c for c in summary["cohorts"] if c["config"]["suite"] == suite]
    return 1 if not selected or any(c["failed"] or c["unknown"] or c["notRun"] for c in selected) else 0


def main(argv=None):
    args = parser().parse_args(argv)
    if args.command == "evals":
        # Offline: do not construct Runtime, read credentials, or rewrite the
        # original benchmark report. Lock each input while taking its snapshot.
        baseline = None
        if args.baseline:
            prior = Run(args.baseline)
            with exclusive(prior.root):
                baseline = evaluate(prior)
        run = Run(args.run)
        with exclusive(run.root):
            result = write_evals(run, baseline)
        print(json.dumps({"run": str(run.root), "report": str(run.root / "evals.md"),
                          "status": result["status"], "profile": result["profile"],
                          "comparison": result.get("comparison")}, ensure_ascii=False, indent=2))
        return 0
    if args.command == "compare":
        if not 0 <= args.max_regression <= 10:
            raise BenchError("max-regression must be between 0 and 10")
        result = compare(read_json(args.baseline / "summary.json"), read_json(args.candidate / "summary.json"), args.max_regression)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if not result["compatible"] else 3 if result["regression"] else 0
    if args.command == "init":
        run = create(args.run, args.profile, args.models_env, args.dataset, args.max_model_requests)
        print(json.dumps({"run": str(run.root), "profile": args.profile, "next": "up"}))
        return 0
    if args.command == "unlock":
        run = Run(args.run)
        lock = run.root / ".operation.lock"
        info = read_json(lock)
        if info["host"] != socket.gethostname():
            raise BenchError("Lock belongs to another host")
        try:
            os.kill(info["pid"], 0)
        except ProcessLookupError:
            lock.unlink()
            return 0
        raise BenchError("Lock owner PID still exists; refusing unlock")
    if args.command == "smoke":
        if args.profile != "fixture":
            raise BenchError("smoke is fixture-only; real calls require explicit staged commands")
        run = create(args.run, "fixture", None, args.dataset, args.max_model_requests)
    else:
        run = Run(args.run, check_inputs=args.command in {"up", "seed", "run", "reconcile"})
    with exclusive(run.root):
        runtime = Runtime(run)
        if args.command == "up":
            runtime.up()
        elif args.command == "seed":
            seed(run)
        elif args.command == "run":
            if max(args.concurrency) > 64 or args.rounds > 10 or args.timeout > 600 or len(args.concurrency) > 8 or len(args.vectors) > 5:
                raise BenchError("Maximum concurrency64, rounds10, timeout600s, 8 concurrency values, 5 vector sizes")
            cases = select_cases(run, args.case_ids)
            if args.suite == "retrieval":
                retrieval(run, cases, args.timeout)
            elif args.suite == "quality":
                quality(run, cases, args.timeout)
            elif args.suite == "stream":
                stream(run, cases, args.requests, args.concurrency, args.rounds, args.timeout)
            elif args.suite == "load":
                load(run, args.vectors, args.requests, args.concurrency, args.timeout)
        elif args.command == "reconcile":
            reconcile(run)
        elif args.command == "down":
            runtime.down(args.remove_volumes)
        elif args.command == "review":
            if args.import_path:
                import_review(run, args.import_path)
            else:
                path = run.root / "review-template.json"
                if path.exists():
                    raise BenchError("Review template exists; preserve edits or choose import")
                atomic_json(path, review_template(run))
        elif args.command == "export":
            print(json.dumps(export(run, args.output), ensure_ascii=False))
        elif args.command == "smoke":
            failure = None
            try:
                runtime.up()
                seed(run)
                cases = select_cases(run, "E01,P03,T01")
                retrieval(run, cases, 30)
                quality(run, cases, 30)
                stream(run, cases, 3, [1, 2], 1, 30)
                load(run, [100], 4, [1, 2], 30)
                summary = write_report(run)
                if any(c["failed"] or c["unknown"] or c["notRun"] for c in summary["cohorts"]):
                    raise BenchError("Smoke contains failed, unknown, or unrun requests")
            except BaseException as error:
                failure = error
                raise
            finally:
                try:
                    runtime.down(remove=True)
                except Exception as cleanup_error:
                    if failure is None:
                        raise
                    atomic_json(run.root / "cleanup-error.json", {"primary": type(failure).__name__,
                                                                 "cleanup": type(cleanup_error).__name__})
                    print("benchmark: cleanup also failed; original failure retained, inspect owned resources", file=sys.stderr)
        summary = write_report(run)
        print(json.dumps({"run": str(run.root), "report": str(run.root / "report.md"),
                          "cohorts": len(summary["cohorts"]), "profile": summary["profile"]}, ensure_ascii=False))
    return measured_exit(summary, args.suite) if args.command == "run" else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BenchError, OSError, ValueError, KeyError) as error:
        # Do not dump Provider responses, credentials or connection strings.
        print("benchmark: " + (str(error) if isinstance(error, BenchError) else type(error).__name__), file=sys.stderr)
        raise SystemExit(1)
