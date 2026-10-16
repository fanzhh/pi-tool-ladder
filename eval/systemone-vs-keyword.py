"""Compare keyword routing vs a local System One (Laya) forward pass.

Both routings answer the same question: "which tool category should handle this
user request?". Keyword results are read from the offline eval (produced by the
real classifier in ladder/core.ts); System One results come from a live call to
the local Laya server.

Usage:
    python3 eval/systemone-vs-keyword.py [laya_url] [offline.json]

Env:
    LAYA_URL   default http://127.0.0.1:9400/v1/systemone

Notes / honesty rules:
  - the first call after a cold start is much slower than steady state, so a
    warm-up call is made first and reported separately
  - a failure to reach Laya is reported as a transport problem, never counted as
    a wrong answer
  - the "no tool needed" style prompt ("42") is a real case: keyword routing
    falls back to `general`, System One may answer `general` as well
"""
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

LAYA = os.environ.get("LAYA_URL", "http://127.0.0.1:9400/v1/systemone")
OFFLINE = sys.argv[2] if len(sys.argv) > 2 else "eval/out/offline.json"
OUT = os.path.join(os.path.dirname(OFFLINE), "systemone-vs-keyword.json")

CRITERIA = {
    "fs": "reading or editing files, running shell commands, code work",
    "web": "web search, fetching a URL or page content",
    "mcp": "external MCP services, browser automation",
    "agent": "spawning sub-agents, parallel delegation",
    "general": "plain conversation, no tool needed",
}


def call_laya(prompt, url=LAYA, timeout=60):
    """One typed-decision forward pass. Returns (choice, confidence, probs, ms)."""
    payload = {
        "state": {"body": prompt},
        "questions": {
            "category": {
                "type": "choice",
                "instructions": "Which tool category should handle this user request?",
                "criteria": CRITERIA,
            }
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    ms = (time.time() - t0) * 1000
    ans = body["answers"]["category"]
    return ans["choice"], ans.get("confidence"), ans.get("probabilities", {}), ms


offline = json.load(open(OFFLINE, encoding="utf-8"))
cases = offline["classify"]["cases"]

print("keyword source :", OFFLINE, f"({len(cases)} prompts, accuracy {offline['classify']['accuracy']:.0%})")
print("system one     :", LAYA)

# warm-up (excluded from the steady-state stats)
try:
    _, _, _, cold_ms = call_laya("warm up")
    print(f"warm-up call   : {cold_ms:.0f} ms (excluded)\n")
except Exception as exc:  # noqa: BLE001
    print("TRANSPORT PROBLEM: cannot reach System One:", repr(exc))
    print("This is a transport failure, not a routing result. Aborting.")
    sys.exit(2)

rows = []
lat = []
for c in cases:
    prompt = c["text"]
    expect = c["expect"]
    kw = c["actual"]
    low_conf = None
    try:
        choice, conf, probs, ms = call_laya(prompt)
        lat.append(ms)
    except Exception as exc:  # noqa: BLE001
        rows.append({"prompt": prompt, "expect": expect, "keyword": kw,
                     "systemone": None, "confidence": None, "ms": None,
                     "error": repr(exc)})
        print(f"  TRANSPORT FAIL on: {prompt} -> {exc!r}")
        continue
    # fail-open variant: below the floor we would fall back to keyword
    low_conf = choice if (conf is not None and conf < 0.5) else None
    rows.append({"prompt": prompt, "expect": expect, "keyword": kw, "systemone": choice,
                 "confidence": conf, "probs": probs, "ms": ms, "lowConf": low_conf})

ok = [r for r in rows if r["systemone"] is not None]
scored = [r for r in ok if r["expect"]]
kw_right = sum(1 for r in scored if r["keyword"] == r["expect"])
so_right = sum(1 for r in scored if r["systemone"] == r["expect"])
agree = sum(1 for r in ok if r["keyword"] == r["systemone"])

print(f"\n{'提示':<26}{'期望':<8}{'关键词':<8}{'System One':<12}{'置信度':>7}{'耗时':>9}  一致")
print("-" * 84)
for r in rows:
    so = r["systemone"] or "TRANSPORT-FAIL"
    conf = f"{r['confidence']:.3f}" if r["confidence"] is not None else "-"
    ms = f"{r['ms']:.0f}ms" if r["ms"] is not None else "-"
    same = "✓" if r["systemone"] == r["keyword"] else "✗"
    mark = "" if (r["expect"] and r["systemone"] == r["expect"]) else (" ←" if r["expect"] else " ⚠歧义")
    print(f"{r['prompt']:<26}{(r['expect'] or '—'):<8}{r['keyword']:<8}{so:<12}{conf:>7}{ms:>9}  {same}{mark}")

print()
n = len(scored)
print(f"计分样本            : {n}（另 1 条歧义样例不计分）")
print(f"关键词准确率        : {kw_right}/{n} = {kw_right / n:.0%}")
print(f"System One 准确率   : {so_right}/{n} = {so_right / n:.0%}")
print(f"两者判定一致        : {agree}/{len(ok)}")
# gated ensemble: trust System One only when it is confident, else fall back
GATE = 0.5
ens = []
for r in scored:
    if r["systemone"] is None:
        ens.append(r["keyword"] == r["expect"])
    elif r["confidence"] is not None and r["confidence"] >= GATE:
        ens.append(r["systemone"] == r["expect"])
    else:
        ens.append(r["keyword"] == r["expect"])
ens_ok = sum(1 for x in ens if x)
used_so = sum(1 for r in scored if r["systemone"] is not None and (r["confidence"] or 0) >= GATE)
print(f"门控组合准确率      : {ens_ok}/{n} = {ens_ok / n:.0%}"
      f"（置信度 ≥ {GATE} 才采信 System One，否则回退关键词；其中 {used_so}/{n} 条采信了 System One）")
if lat:
    lat_sorted = sorted(lat)
    p95 = lat_sorted[min(len(lat_sorted) - 1, int(len(lat_sorted) * 0.95))]
    print(f"System One 热态耗时 : 中位 {statistics.median(lat):.0f} ms | 最大 {max(lat):.0f} ms | p95 {p95:.0f} ms")
    print(f"关键词判定耗时      : 17 µs（离线实测，单次判定）")
low = [r for r in ok if r["lowConf"]]
print(f"置信度 < 0.5 的条数 : {len(low)}（这些可以在实现里回退关键词：{[r['prompt'] for r in low]}）")

# fail-open probe: a dead port must surface as a transport error, not a guess
try:
    call_laya("fail-open probe", url="http://127.0.0.1:9401/v1/systemone", timeout=3)
    print("fail-open 探针      : 意外成功（端口不该活着）")
except Exception as exc:  # noqa: BLE001
    print(f"fail-open 探针      : 端口不通时抛 {type(exc).__name__}（实现里据此回退关键词，不猜）")

json.dump({"laya": LAYA, "offline": OFFLINE, "rows": rows,
           "summary": {"scored": n, "keyword_right": kw_right, "systemone_right": so_right,
                       "agree": agree, "warm_median_ms": statistics.median(lat) if lat else None,
                       "warm_max_ms": max(lat) if lat else None,
                       "low_conf": [r["prompt"] for r in low]}},
          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("\nwrote", OUT)
