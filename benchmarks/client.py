"""Bounded HTTP/SSE measurement without retries or environment proxy inheritance."""
import http.client
import json
import socket
import threading
import time
import urllib.parse

from .store import BenchError

MAX_BODY = 8 * 1024 * 1024
MAX_LINE = 4 * 1024 * 1024


def events(lines):
    event, payload, size = "message", [], 0
    for raw in lines:
        if len(raw) > MAX_LINE:
            raise BenchError("SSE_LINE_TOO_LARGE")
        line = raw.decode("utf-8").rstrip("\r\n")
        if not line:
            if payload:
                yield event, json.loads("\n".join(payload))
            event, payload, size = "message", [], 0
        elif line.startswith("event:"):
            event = line[6:].lstrip(" ")
        elif line.startswith("data:"):
            size += len(raw)
            if size > MAX_BODY:
                raise BenchError("SSE_EVENT_TOO_LARGE")
            payload.append(line[5:].lstrip(" "))
    # EOF without a blank-line-terminated event is incomplete.


def validate_done(payload, request_id, session_id):
    if not isinstance(payload, dict) or payload.get("clientRequestId") != request_id:
        raise BenchError("MISMATCHED_DONE_ID")
    if not isinstance(payload.get("answer"), str) or not isinstance(payload.get("citations"), list):
        raise BenchError("MALFORMED_DONE")
    for key, role in (("userMessage", "user"), ("assistantMessage", "assistant")):
        message = payload.get(key)
        if not isinstance(message, dict) or message.get("role") != role or not message.get("id"):
            raise BenchError("MALFORMED_DONE")
        if message.get("sessionId") != session_id or message.get("clientRequestId") != request_id:
            raise BenchError("MISMATCHED_DONE_MESSAGE")
    if payload["assistantMessage"].get("content") != payload["answer"]:
        raise BenchError("INCONSISTENT_DONE_ANSWER")


class Client:
    def __init__(self, base, timeout=120):
        parsed = urllib.parse.urlsplit(base)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port:
            raise BenchError("Benchmark API must be the managed loopback HTTP endpoint")
        self.host, self.port, self.prefix = parsed.hostname, parsed.port, parsed.path.rstrip("/")
        self.timeout, self.token = timeout, None

    def exchange(self, method, path, body=None, stream_ids=None):
        if not path.startswith("/") or path.startswith("//"):
            raise BenchError("Invalid relative API path")
        started = time.perf_counter()
        expired = threading.Event()
        transport = [None]
        connection = http.client.HTTPConnection(self.host, self.port, timeout=min(self.timeout, 10))
        result = {"ok": False, "httpStatus": None, "errorCode": None, "firstEventMs": None,
                  "firstDeltaMs": None, "doneMs": None, "deltaCount": 0}
        def expire():
            expired.set()
            if transport[0]:
                try:
                    transport[0].shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        timer = threading.Timer(self.timeout, expire)
        timer.daemon = True
        timer.start()
        try:
            connection.connect()
            transport[0] = connection.sock
            if expired.is_set():
                raise BenchError("TOTAL_TIMEOUT")
            connection.sock.settimeout(max(.001, self.timeout - (time.perf_counter() - started)))
            headers = {"Content-Type": "application/json", "Connection": "close"}
            if self.token:
                headers["Authorization"] = "Bearer " + self.token
            encoded = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
            connection.request(method, self.prefix + path, encoded, headers)
            response = connection.getresponse()
            result["httpStatus"] = response.status
            result["headersMs"] = (time.perf_counter() - started) * 1000
            result["traceId"] = response.getheader("X-Trace-ID")
            if response.status != 200 and stream_ids or not stream_ids:
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise BenchError("BODY_TOO_LARGE")
                payload = json.loads(raw) if raw else None
                result["body"] = payload
                result["ok"] = 200 <= response.status < 300
                if not result["ok"]:
                    result["errorCode"] = payload.get("code", "HTTP_ERROR") if isinstance(payload, dict) else "HTTP_ERROR"
            else:
                if "text/event-stream" not in (response.getheader("Content-Type") or ""):
                    raise BenchError("INVALID_STREAM_CONTENT_TYPE")
                text, total_bytes = [], 0
                for event, payload in events(iter(lambda: response.readline(MAX_LINE + 1), b"")):
                    elapsed = (time.perf_counter() - started) * 1000
                    if expired.is_set():
                        raise BenchError("TOTAL_TIMEOUT")
                    if not isinstance(payload, dict):
                        raise BenchError("MALFORMED_EVENT")
                    if result["firstEventMs"] is None:
                        result["firstEventMs"] = elapsed
                    if event == "citations":
                        if not isinstance(payload.get("citations"), list):
                            raise BenchError("MALFORMED_CITATIONS")
                        result["streamCitations"] = payload["citations"]
                    elif event == "delta":
                        delta = payload.get("text")
                        if not isinstance(delta, str):
                            raise BenchError("MALFORMED_DELTA")
                        total_bytes += len(delta.encode())
                        if total_bytes > MAX_BODY:
                            raise BenchError("ANSWER_TOO_LARGE")
                        text.append(delta)
                        result["deltaCount"] += 1
                        if delta.strip() and result["firstDeltaMs"] is None:
                            result["firstDeltaMs"] = elapsed
                    elif event == "error":
                        result["errorCode"] = str(payload.get("code", "STREAM_ERROR"))
                        break
                    elif event == "done":
                        validate_done(payload, *stream_ids)
                        result.update({"done": payload, "doneMs": elapsed, "ok": True,
                                       "answer": payload["answer"], "citations": payload["citations"],
                                       "answerStatus": payload["assistantMessage"].get("answerStatus"),
                                       "rerankFallback": payload.get("rerankFallback")})
                        break
                result["visibleText"] = "".join(text)
                if not result["ok"] and not result["errorCode"]:
                    result["errorCode"] = "TOTAL_TIMEOUT" if expired.is_set() else "EOF_WITHOUT_DONE"
        except Exception as error:
            result["ok"] = False
            result["errorCode"] = "TOTAL_TIMEOUT" if expired.is_set() else (str(error) if isinstance(error, BenchError) else type(error).__name__)
        finally:
            timer.cancel()
            connection.close()
            result["totalMs"] = (time.perf_counter() - started) * 1000
        return result

    def api(self, method, path, body=None):
        result = self.exchange(method, path, body)
        if not result["ok"]:
            raise BenchError("API operation failed: " + str(result["errorCode"]))
        return result["body"]

    def login(self, password):
        self.token = self.api("POST", "/auth/login", {"username": "benchmark", "password": password})["token"]

    def stream(self, session_id, question, request_id):
        result = self.exchange("POST", "/chat/sessions/" + session_id + "/messages/stream",
                               {"content": question, "clientRequestId": request_id},
                               stream_ids=(request_id, session_id))
        return {**result, "sessionId": session_id, "clientRequestId": request_id}
