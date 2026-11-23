"""Deterministic protocol fixture. It does not measure real model quality."""
import hashlib
import json
import math
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIMENSION = int(os.environ.get("FIXTURE_DIMENSION", "64"))


def tokens(text):
    return set(text[i:i + 2] for i in range(max(0, len(text) - 1)))


def vector(text):
    values = [0.] * DIMENSION
    for token in tokens(text) or {text}:
        code = hashlib.sha256(token.encode()).digest()
        values[int.from_bytes(code[:4], "little") % DIMENSION] += 1 if code[4] & 1 else -1
    length = math.sqrt(sum(v * v for v in values)) or 1
    return [v / length for v in values]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 8 * 1024 * 1024:
            self.send_error(413)
            return
        request = json.loads(self.rfile.read(length))
        if self.path.endswith("/embeddings"):
            texts = request["input"]
            if isinstance(texts, str):
                texts = [texts]
            self.respond({"object": "list", "model": "fixture-embedding",
                          "data": [{"object": "embedding", "index": i, "embedding": vector(text)} for i, text in enumerate(texts)],
                          "usage": {"prompt_tokens": len(texts), "total_tokens": len(texts)}})
        elif self.path.endswith("/rerank"):
            query = tokens(request["query"])
            rows = [{"index": i, "relevance_score": .4 + .6 * len(query & tokens(text)) / max(1, len(query))}
                    for i, text in enumerate(request["documents"])]
            self.respond({"results": sorted(rows, key=lambda row: -row["relevance_score"])})
        elif self.path.endswith("/chat/completions"):
            messages = request["messages"]
            if "standaloneQuery" in messages[0]["content"]:
                content = json.dumps({"intent": "knowledge_base", "standaloneQuery": messages[-1]["content"], "reason": "fixture"}, ensure_ascii=False)
            else:
                # A predictable answer to test transport/persistence. It is not a gold answer.
                content = "这是协议替身生成的测试回答，供检查流式输出、引用和消息保存。[source: 1]"
            if request.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for index in range(0, len(content), 8):
                    body = {"id": "fixture", "object": "chat.completion.chunk", "created": int(time.time()),
                            "model": "fixture-chat", "choices": [{"index": 0, "delta": {"content": content[index:index + 8]}, "finish_reason": None}]}
                    self.wfile.write(("data: " + json.dumps(body, ensure_ascii=False) + "\n\n").encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                self.respond({"id": "fixture", "object": "chat.completion", "created": int(time.time()), "model": "fixture-chat",
                              "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                              "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        else:
            self.send_error(404)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8089), Handler).serve_forever()
