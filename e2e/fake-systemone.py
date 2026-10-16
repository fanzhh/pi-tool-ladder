#!/usr/bin/env python3
"""Minimal fake System One endpoint for the E2E — no local model needed.

    POST /v1/systemone  -> {"answers": {"category": {"choice": ..., "confidence": ...}}}
    GET  /health        -> {"status": "ok"}

Fail modes:
    --status 500        returns an HTTP error (plugin must fall back to keywords)
    --choice <unknown>  returns a category that is not in the config (must be rejected)

Usage:
    python3 e2e/fake-systemone.py --port 9415 --choice mcp --confidence 0.99
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=9415)
ap.add_argument("--choice", default="mcp")
ap.add_argument("--confidence", type=float, default=0.99)
ap.add_argument("--status", type=int, default=200)
args = ap.parse_args()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            req = {}
        if args.status != 200:
            self._send(args.status, {"error": "fake failure"})
            return
        prompt = ((req.get("state") or {}).get("body") or "")[:40]
        print(f"[fake-systemone] choice={args.choice} confidence={args.confidence} prompt={prompt}", flush=True)
        self._send(200, {
            "model": "fake-systemone",
            "answers": {
                "category": {
                    "type": "choice",
                    "choice": args.choice,
                    "probabilities": {args.choice: args.confidence},
                    "confidence": args.confidence,
                }
            },
        })

    def log_message(self, *a):  # keep stdout clean for the E2E log
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
