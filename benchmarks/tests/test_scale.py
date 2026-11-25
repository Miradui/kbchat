"""Dataset partition identity and larger ingestion boundaries."""
import contextlib
import copy
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from benchmarks.runner import seed, select_cases
from benchmarks.store import BenchError, Run, atomic_json, dataset, digest, file_hash


class DatasetSplitTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        (self.root / "source.md").write_text("# Official source\nAn explicit condition.")
        self.spec = {"groups": {"kb": "Shared corpus"}, "documents": [{"key": "doc", "group": "kb",
            "file": "source.md", "source": {"commit": "pinned", "cleanSha256": file_hash(self.root / "source.md")}}]}
        self.cases = [{"id": name, "group": "kb", "question": "What is the condition " + name + "?",
                       "split": split, "familyId": name, "evidence": [{"doc": "doc", "anchors": ["explicit condition"]}]}
                      for name, split in [("a", "dev"), ("b", "test")]]

    def save(self):
        atomic_json(self.root / "dataset.json", self.spec)
        atomic_json(self.root / "cases.json", {"cases": self.cases})
        return dataset(self.root)

    def test_partition_intersection_unknown_ids_and_empty_selection(self):
        run = SimpleNamespace(data=self.save())
        self.assertEqual([c["id"] for c in select_cases(run, split="test")], ["b"])
        self.assertEqual([c["id"] for c in select_cases(run, "a,b", "dev")], ["a"])
        for ids, split in [("b", "dev"), ("absent", "dev"), (None, "unknown")]:
            with self.subTest(ids=ids, split=split), self.assertRaises(BenchError):
                select_cases(run, ids, split)

    def test_question_family_cannot_leak_between_splits(self):
        self.cases[1]["familyId"] = "a"
        with self.assertRaisesRegex(BenchError, "family cannot cross"):
            self.save()

    def test_mixed_missing_splits_and_bad_labels_rejected(self):
        for change in ({"split": "validation"}, {"familyId": ""}):
            saved = copy.deepcopy(self.cases)
            self.cases[0].update(change)
            with self.assertRaises(BenchError):
                self.save()
            self.cases = saved
        self.cases[1].pop("split")
        self.cases[1].pop("familyId")
        with self.assertRaisesRegex(BenchError, "label every"):
            self.save()

    def test_source_metadata_is_frozen_and_clean_content_verified(self):
        original = self.save()
        self.spec["documents"][0]["source"]["commit"] = "other"
        self.assertNotEqual(digest(original), digest(self.save()))
        (self.root / "source.md").write_text("modified")
        with self.assertRaisesRegex(BenchError, "manifest"):
            self.save()

    def test_old_demo_without_split_metadata_remains_valid(self):
        for case in self.cases:
            case.pop("split")
            case.pop("familyId")
        run = SimpleNamespace(data=self.save())
        self.assertEqual(len(select_cases(run)), 2)
        with self.assertRaisesRegex(BenchError, "No cases"):
            select_cases(run, split="test")


class IngestionTests(unittest.TestCase):
    def run_seed(self, content="gold", pending=False, timeout=600):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        self.seed_root = root
        data = {"spec": {"groups": {"g": "group"}}, "documents": {
            "d": {"title": "Document", "content": "gold", "group": "g"}},
            "cases": [{"id": "q", "group": "g", "question": "q", "evidence": [{"doc": "d", "anchors": ["gold"]}]}]}
        atomic_json(root / "dataset.json", data)
        atomic_json(root / "manifest.json", {"schemaVersion": 1, "runDirectory": str(root),
                    "runId": "12345678123456781234567812345678", "datasetHash": digest(data), "maxModelRequests": 10})
        run = Run(root)
        run.save_state({"phase": "running", "knowledgeBases": {"g": "kb"}, "documents": {"d": {"id": "doc"}}})
        pages = []
        def api(method, path):
            if path == "/documents/doc":
                return {"status": "embedding" if pending else "completed"}
            if "chunks" in path:
                page = int(path.rsplit("=", 1)[1]); pages.append(page)
                items = ([{"content": "noise", "tokenCount": 1}] * 100 if page == 1 else [{"content": content, "tokenCount": 2}])
                return {"items": items, "total": 101}
            raise AssertionError(path)
        runtime = SimpleNamespace(client=lambda: SimpleNamespace(api=api))
        with patch("benchmarks.runner.Runtime", return_value=runtime), contextlib.redirect_stdout(io.StringIO()):
            seed(run, timeout)
        return run, pages

    def test_all_chunk_pages_are_validated_before_seed_ready(self):
        run, pages = self.run_seed()
        self.assertEqual(pages, [1, 2])
        self.assertTrue(run.state()["seeded"])
        from benchmarks.store import read_json
        self.assertEqual(read_json(run.root / "index.json")["statistics"]["estimatedChunkTokens"], 102)

    def test_missing_published_gold_cannot_leave_seed_ready(self):
        with self.assertRaisesRegex(BenchError, "Gold evidence"):
            self.run_seed(content="no matching evidence")
        from benchmarks.store import read_json
        self.assertFalse(read_json(self.seed_root / "state.json")["seeded"])
        self.assertEqual(read_json(self.seed_root / "index.json")["unavailableEvidenceCases"], ["q"])

    def test_seed_timeout_is_applied_without_restarting_provider_calls(self):
        with patch("benchmarks.runner.time.monotonic", side_effect=[0, 11]), self.assertRaisesRegex(BenchError, "deadline"):
            self.run_seed(pending=True, timeout=10)


if __name__ == "__main__":
    unittest.main()
