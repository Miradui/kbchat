"""Rebuild a pinned, attributed Kubernetes Chinese documentation corpus offline."""
import argparse
import hashlib
import html
import json
import re
import shlex
import subprocess
from pathlib import Path

from .store import BenchError, atomic_json, file_hash

COMMIT = "1ad3951a91f073a5ac0037ede662bebdc054774b"
TRANSFORM = "kubernetes-zh-markdown-v2"
SHORTCODE = re.compile(r"{{[<%]\s*(.*?)\s*[>%]}}", re.S)


def front_matter(text):
    metadata = {}
    if text.startswith("---\n"):
        header, text = text[4:].split("\n---", 1)
        for line in header.splitlines():
            match = re.match(r"^([\w-]+):\s*(.*?)\s*$", line)
            if match:
                metadata[match[1]] = match[2].strip('"\'')
    return metadata, text.strip()


class Cleaner:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.dependencies = {}
        config = self.read(self.root / "hugo.toml")
        self.version = re.search(r'^version\s*=\s*"v([\d.]+)"', config, re.M)[1]
        self.latest = re.search(r'^latest\s*=\s*"v([\d.]+)"', config, re.M)[1]

    def read(self, path):
        path = path.resolve()
        if not path.is_relative_to(self.root) or not path.is_file():
            raise BenchError("Missing or unsafe pinned dependency")
        self.dependencies[str(path.relative_to(self.root))] = file_hash(path)
        return path.read_text(encoding="utf-8")

    def feature_state(self, name):
        # The upstream shortcode treats English stage metadata as canonical.
        text = self.read(self.root / "content/en/docs/reference/command-line-tools-reference/feature-gates" / (name + ".md"))
        metadata, _ = front_matter(text)
        if metadata.get("title") != name:
            raise BenchError("Feature gate title mismatch")
        header = text[4:].split("\n---", 1)[0]
        blocks = re.findall(r"(?ms)^\s+- stage:\s*(\w+)\s*\n(.*?)(?=^\s+- stage:|\Z)", header)
        stages = []
        for stage, block in blocks:
            values = dict(re.findall(r'^\s+(\w+):\s*["\']?([\w.]+)["\']?\s*$', block, re.M))
            if stage not in {"alpha", "beta", "stable", "deprecated"} or not values.get("fromVersion") or values.get("defaultValue") not in {"true", "false"}:
                raise BenchError("Unsupported feature-gate metadata")
            stages.append({"stage": stage, **values})
        if not stages:
            raise BenchError("Missing feature-gate stages")
        current = stages[-1]
        result = f"\n功能状态：{name}，Kubernetes {current['fromVersion']}，{current['stage']}；首次引入于 {stages[0]['fromVersion']}。"
        if metadata.get("removed") == "true":
            result += "特性门控已移除。"
            if current["stage"] == "stable":
                result += "该特性已稳定，不能再通过此门控禁用。"
            else:
                result += "移除前末阶段起始版本为 " + current["fromVersion"] + "，结束版本为 " + current.get("toVersion", "未注明") + "。"
        else:
            result += "默认" + ("启用" if current["defaultValue"] == "true" else "禁用") + "。"
            if current.get("locked") == "true":
                result += "门控值已锁定。"
            elif current["defaultValue"] == "false":
                result += "使用前需配置相应特性门控。"
        return result + "\n"

    def thirdparty_notice(self, attrs):
        key = "thirdparty_message_single_item" if attrs.get("single") == "true" else (
            "thirdparty_message_vendor" if attrs.get("vendor") == "true" else "thirdparty_message")
        translations = self.read(self.root / "i18n/zh-cn/zh-cn.toml")
        match = re.search(r"(?ms)^\[" + key + r'\]\s*\nother\s*=\s*"""(.*?)"""', translations)
        if not match:
            raise BenchError("Missing pinned third-party translation")
        text = re.sub(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', r'[\2](\1)', match[1], flags=re.S)
        return "\n\n" + html.unescape(re.sub(r"<[^>]+>", "", text)) + "\n\n"

    def clean(self, path, depth=0):
        if depth > 8:
            raise BenchError("Recursive documentation include")
        raw = self.read(path)
        metadata, body = front_matter(raw)
        body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
        body = re.sub(r"{{[<%]\s*comment\s*[>%]}}.*?{{[<%]\s*/comment\s*[>%]}}", "", body, flags=re.S)

        def replace(match):
            words = shlex.split(match[1])
            if not words:
                raise BenchError("Empty shortcode")
            name, args = words[0], words[1:]
            attrs = dict(word.split("=", 1) for word in args if "=" in word)
            if name.startswith("/"):
                if name[1:] in {"note", "warning", "caution", "tabs", "tab", "table", "details", "pageinfo", "alert"}:
                    return "\n"
                if name[1:] in {"highlight", "mermaid"}:
                    return "\n```\n"
                raise BenchError("Unsupported closing shortcode " + name)
            if name == "glossary_tooltip":
                return attrs["text"] if "text" in attrs else attrs["term_id"]
            if name in {"note", "warning", "caution"}:
                return "\n\n**" + {"note": "说明", "warning": "警告", "caution": "注意"}[name] + "：**\n\n"
            if name in {"tabs", "table", "pageinfo", "alert"}:
                return "\n"
            if name in {"tab", "details"}:
                return "\n\n### " + attrs.get("name", attrs.get("summary", "详细说明")) + "\n\n"
            if name in {"highlight", "mermaid"}:
                return "\n```" + (args[0] if name == "highlight" and args else "mermaid") + "\n"
            if name == "feature-state":
                if "feature_gate_name" in attrs:
                    return self.feature_state(attrs["feature_gate_name"])
                version = attrs.get("for_k8s_version", "")
                if not version or attrs.get("state") not in {"alpha", "beta", "stable", "deprecated"}:
                    raise BenchError("Missing manual feature state")
                return "\n功能状态：Kubernetes " + version + "，" + attrs.get("state", "") + "。\n"
            if name == "heading":
                headings = {"prerequisites": "准备开始", "whatsnext": "接下来", "objectives": "目标", "cleanup": "清理", "synopsis": "概述", "discussion": "讨论"}
                if not args or args[0] not in headings:
                    raise BenchError("Unsupported heading")
                return "## " + headings[args[0]]
            if name == "param":
                if args == ["version"]:
                    return "v" + self.version
                raise BenchError("Unsupported version parameter")
            if name == "skew":
                key = args[0]
                version = self.version if key.startswith("current") else self.latest
                major, minor = map(int, version.split("."))
                if key in {"currentVersion", "latestVersion"}:
                    return version
                if key in {"nextMinorVersion", "prevMinorVersion", "oldestMinorVersion"}:
                    return f"{major}.{minor + {'nextMinorVersion': 1, 'prevMinorVersion': -1, 'oldestMinorVersion': -2}[key]}"
                if key in {"currentVersionAddMinor", "latestVersionAddMinor"}:
                    return str(major) + (args[2] if len(args) > 2 else ".") + str(minor + int(args[1]))
                raise BenchError("Unsupported version skew")
            if name == "version-check":
                version = metadata.get("min-kubernetes-server-version")
                return ("Kubernetes 服务端最低版本：" + version + "。" if version else "") + "使用 `kubectl version` 检查版本。"
            if name in {"code_sample", "example"}:
                filename = attrs["file"].lstrip("/")
                choices = [path.parent / filename, self.root / "content/zh-cn/examples" / filename,
                           self.root / "content/en/examples" / filename]
                source = next((p for p in choices if p.is_file()), None)
                if source is None:
                    raise BenchError("Missing pinned code sample " + filename)
                content = self.read(source).rstrip()
                fence = "`" * max(3, max((len(m[0]) + 1 for m in re.finditer(r"`+", content)), default=3))
                return "\n\n示例文件：`" + filename + "`\n\n" + fence + attrs.get("language", source.suffix.lstrip(".")) + "\n" + content + "\n" + fence + "\n\n"
            if name == "include":
                choices = [self.root / "content/zh-cn/includes" / args[0], path.parent / args[0]]
                source = next((p for p in choices if p.is_file()), None)
                if source is None:
                    raise BenchError("Missing pinned include " + args[0])
                return "\n" + self.clean(source, depth + 1)[1] + "\n"
            if name == "glossary_definition":
                source = self.root / "content/zh-cn/docs/reference/glossary" / (attrs["term_id"] + ".md")
                content = self.clean(source, depth + 1)[1]
                if attrs.get("length") == "short":
                    content = next((p for p in content.split("\n\n") if p.strip() and not p.startswith("#")), "")
                return attrs.get("prepend", "") + content
            if name == "api-reference":
                return "API 参考：" + attrs["page"]
            if name == "figure":
                return "\n[图片未纳入文字评测：" + attrs.get("caption", attrs.get("title", attrs.get("src", ""))) + "]\n"
            if name == "relref":
                return args[0]
            if name == "thirdparty-content":
                return self.thirdparty_notice(attrs)
            if name in {"toc", "kat-button"}:
                return "\n[网页导航/交互控件已省略]\n"
            raise BenchError("Unsupported shortcode " + name)

        body = SHORTCODE.sub(replace, body)
        if re.search(r"{{[<%]", body):
            raise BenchError("Unexpanded shortcode")
        body = re.sub(r"\n{3,}", "\n\n", body).strip()
        return metadata.get("title", path.stem), body


def build(source_root, destination, selected):
    root, destination = Path(source_root).resolve(), Path(destination).resolve()
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if revision != COMMIT or subprocess.check_output(["git", "status", "--porcelain"], cwd=root).strip():
        raise BenchError("Use the clean pinned upstream checkout")
    documents = []
    for rel in selected:
        path = root / rel
        cleaner = Cleaner(root)
        title, body = cleaner.clean(path)
        text = "# " + title + "\n\n" + body + "\n"
        if not 1500 <= len(text.encode()) <= 1024 * 1024:
            raise BenchError("Selected document outside corpus size bounds: " + rel)
        key = str(Path(rel).relative_to("content/zh-cn/docs")).removesuffix(".md").replace("/", "--")
        output = destination / "corpus" / (key + ".md")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
        documents.append({"key": key, "title": title, "group": "kubernetes", "file": str(output.relative_to(destination)),
            "topic": Path(rel).parts[4], "source": {"repository": "https://github.com/kubernetes/website", "commit": COMMIT,
            "path": rel, "url": "https://github.com/kubernetes/website/blob/" + COMMIT + "/" + rel,
            "rawSha256": file_hash(path), "cleanSha256": file_hash(output), "rawBytes": path.stat().st_size,
            "cleanBytes": output.stat().st_size, "transformVersion": TRANSFORM, "dependencies": cleaner.dependencies}})
    atomic_json(destination / "dataset.json", {"id": "kubernetes-zh-200-v1", "groups": {"kubernetes": "Kubernetes官方中文文档快照"},
        "description": "200 pinned official pages in one shared retrieval pool; Chinese source-aware RAG evaluation, not private-business generalization.",
        "sourceCommit": COMMIT, "license": "CC-BY-4.0", "transformVersion": TRANSFORM, "documents": documents})
    (destination / "LICENSE.txt").write_bytes((root / "LICENSE").read_bytes())
    return documents


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--selection", required=True, type=Path)
    args = parser.parse_args()
    documents = build(args.source, args.output, json.loads(args.selection.read_text()))
    print(json.dumps({"documents": len(documents), "cleanBytes": sum(d["source"]["cleanBytes"] for d in documents)}))
