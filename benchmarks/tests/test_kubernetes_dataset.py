"""Pinned corpus reproducibility and gold/split contracts, without model calls."""
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from benchmarks.build_kubernetes import Cleaner, front_matter
from benchmarks.store import BenchError, TOOL, dataset, digest, normalized


class KubernetesDatasetTests(unittest.TestCase):
    def test_committed_corpus_and_questions_are_complete_and_separated(self):
        data = dataset(TOOL / "datasets/kubernetes-zh-200")
        self.assertEqual(len(data["documents"]), 200)
        self.assertEqual(len(data["cases"]), 200)
        self.assertEqual(Counter(c["split"] for c in data["cases"]), {"dev": 150, "test": 50})
        self.assertEqual(Counter(c["split"] for c in data["cases"] if not c["evidence"]), {"dev": 30, "test": 10})
        self.assertEqual({d["group"] for d in data["documents"].values()}, {"kubernetes"})
        self.assertEqual(len({digest(normalized(d["content"])) for d in data["documents"].values()}), 200)
        for split in ("dev", "test"):
            for case in [c for c in data["cases"] if c["split"] == split]:
                self.assertEqual(case["expectedIntent"], "knowledge_base")
                self.assertTrue(case.get("expectedFacts") if case["evidence"] else case.get("expectedRefusal"))
                if not case["evidence"]:
                    self.assertTrue(case.get("negativeCheck"))
        evidence = {s: {u["doc"] for c in data["cases"] if c["split"] == s for u in c["evidence"]}
                    for s in ("dev", "test")}
        self.assertFalse(evidence["dev"] & evidence["test"])
        self.assertGreaterEqual(sum(len({u["doc"] for u in c["evidence"]}) > 1 for c in data["cases"]), 24)
        for doc in data["documents"].values():
            self.assertNotIn("{{<", doc["content"])
            self.assertNotIn("{{%", doc["content"])
            self.assertTrue(doc["source"]["dependencies"])
            self.assertNotIn("功能状态：Kubernetes ，。", doc["content"])
        sidecar = data["documents"]["concepts--workloads--pods--sidecar-containers"]
        self.assertIn("Kubernetes 1.33，stable", sidecar["content"])
        self.assertIn("门控值已锁定", sidecar["content"])
        self.assertTrue(any("feature-gates/SidecarContainers.md" in p for p in sidecar["source"]["dependencies"]))
        self.assertIn("Kubernetes 项目作者不负责这些项目", data["documents"]["concepts--cluster-administration--addons"]["content"])

    def test_cleaner_preserves_facts_and_inlines_pinned_examples(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "hugo.toml").write_text('version = "v1.37"\nlatest = "v1.37"\n')
            page = root / "page.md"
            page.write_text('---\ntitle: "中文页面"\n---\n<!-- English draft -->\n'
                            '{{< note >}}保留条件{{< /note >}}\n{{< skew currentVersion >}}\n'
                            '{{% code_sample file="sample.yaml" %}}\n{{< glossary_tooltip text="Pod" term_id="pod" >}}')
            (root / "sample.yaml").write_text('replicas: 3\n')
            cleaner = Cleaner(root)
            title, body = cleaner.clean(page)
            self.assertEqual(title, "中文页面")
            self.assertIn("保留条件", body)
            self.assertIn("1.37", body)
            self.assertIn("```yaml\nreplicas: 3\n```", body)
            self.assertNotIn("English draft", body)
            self.assertIn("sample.yaml", cleaner.dependencies)

    def test_unknown_template_and_outside_dependency_are_not_silently_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "hugo.toml").write_text('version = "v1.37"\nlatest = "v1.37"\n')
            page = root / "page.md"
            page.write_text('{{< unknown-facts >}}')
            with self.assertRaisesRegex(BenchError, "Unsupported"):
                Cleaner(root).clean(page)
            with self.assertRaisesRegex(BenchError, "unsafe"):
                Cleaner(root).read(root.parent / "outside")

    def test_automatic_feature_metadata_and_thirdparty_branches_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "hugo.toml").write_text('version = "v1.37"\nlatest = "v1.37"\n')
            gate = root / "content/en/docs/reference/command-line-tools-reference/feature-gates/Gate.md"
            gate.parent.mkdir(parents=True)
            gate.write_text('---\ntitle: Gate\nstages:\n  - stage: alpha\n    defaultValue: false\n    fromVersion: "1.30"\n'
                            '  - stage: stable\n    defaultValue: true\n    locked: true\n    fromVersion: "1.33"\n---\n')
            translations = root / "i18n/zh-cn/zh-cn.toml"
            translations.parent.mkdir(parents=True)
            translations.write_text('[thirdparty_message]\nother = """作者不负责这些项目"""\n'
                                    '[thirdparty_message_single_item]\nother = """不是 Kubernetes 的一部分"""\n'
                                    '[thirdparty_message_vendor]\nother = """外部供应商"""\n')
            page = root / "page.md"
            page.write_text('{{< feature-state feature_gate_name="Gate" >}}\n{{< thirdparty-content >}}\n'
                            '{{< thirdparty-content single="true" >}}\n{{< thirdparty-content vendor="true" >}}')
            cleaner = Cleaner(root)
            _, body = cleaner.clean(page)
            for expected in ['1.33，stable', '首次引入于 1.30', '默认启用', '门控值已锁定', '作者不负责', '不是 Kubernetes 的一部分', '外部供应商']:
                self.assertIn(expected, body)
            self.assertIn(str(gate.relative_to(root)), cleaner.dependencies)
            self.assertIn(str(translations.relative_to(root)), cleaner.dependencies)


if __name__ == "__main__":
    unittest.main()
