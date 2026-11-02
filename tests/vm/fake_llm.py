#!/usr/bin/env python3
"""Fake OpenAI-compatible upstream for tests.

Serves GET /v1/models and POST /v1/chat/completions (streaming and not),
answering every chat request with a fixed reply. Each request is recorded
(path, Authorization header, model) and can be read back from GET /requests.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RECORDS: list[dict] = []
RECORDS_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "fake-llm/1"
    reply = "Hello from the fake LLM."
    models = ["test-model"]

    def log_message(self, fmt: str, *args) -> None:  # quieter default logging
        print(f"fake-llm: {self.command} {self.path} -> {fmt % args}", flush=True)

    def _record(self, body: dict | None) -> None:
        with RECORDS_LOCK:
            RECORDS.append(
                {
                    "method": self.command,
                    "path": self.path,
                    "authorization": self.headers.get("authorization"),
                    "model": (body or {}).get("model"),
                    "stream": bool((body or {}).get("stream")),
                }
            )

    def _json(self, status: int, payload: object) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/requests":
            with RECORDS_LOCK:
                self._json(200, RECORDS)
            return
        if self.path == "/v1/models":
            self._record(None)
            self._json(200, {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "fake"} for m in self.models]})
            return
        self._json(404, {"error": {"message": "not found"}})

    def do_DELETE(self) -> None:
        if self.path == "/requests":
            with RECORDS_LOCK:
                RECORDS.clear()
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": {"message": "invalid json"}})
            return
        if self.path != "/v1/chat/completions":
            self._record(body)
            self._json(404, {"error": {"message": "not found"}})
            return
        self._record(body)
        model = body.get("model") or self.models[0]
        created = int(time.time())
        cid = f"chatcmpl-fake-{created}"
        usage = {"prompt_tokens": 10, "completion_tokens": 6, "total_tokens": 16}
        if not body.get("stream"):
            self._json(
                200,
                {
                    "id": cid,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": self.reply}, "finish_reason": "stop"}],
                    "usage": usage,
                },
            )
            return

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()

        def chunk(delta: dict, finish: str | None = None, with_usage: bool = False) -> None:
            payload = {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            if with_usage:
                payload["usage"] = usage
            self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
            self.wfile.flush()

        chunk({"role": "assistant", "content": ""})
        for word in self.reply.split(" "):
            chunk({"content": word if word == self.reply.split(" ")[0] else " " + word})
        chunk({}, finish="stop", with_usage=True)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9000)
    ap.add_argument("--reply", default=Handler.reply)
    ap.add_argument("--model", action="append", dest="models")
    args = ap.parse_args()
    Handler.reply = args.reply
    if args.models:
        Handler.models = args.models
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"fake-llm listening on {args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
