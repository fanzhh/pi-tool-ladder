#!/bin/bash
# 本地模型 A/B：原版 pi vs 阶梯 pi（真实配置 / 189 工具风暴两种环境）
#
# 同一台推理机（mini6 上的 qwen3.8:27b-mlx）、同一句提示、连续执行，只改配置。
# 记录：整进程墙钟、进提示词的工具体量（取自会话文件 toolsAdded）、阶梯决策日志。
#
# 产物：eval/out/ab-local.md、eval/out/ab-local.jsonl
set -u

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${AB_WORK:-/tmp/pi-tool-ladder-ab}"
PROVIDER="${AB_PROVIDER:-ollama}"
MODEL="${AB_MODEL:-qwen3.8:27b-mlx}"
EXT_LADDER="$PROJ/ladder/index.ts"
EXT_FAKE="$PROJ/e2e/fake-tools.ts"
PROMPT="只回两个字：收到"
OUT="$PROJ/eval/out"
JSONL="$OUT/ab-local.jsonl"

AB_WORK="$WORK" python3 -c 'import os,shutil; shutil.rmtree(os.environ["AB_WORK"], ignore_errors=True)'
mkdir -p "$WORK" "$OUT"
: > "$JSONL"

run() { # run <标签> <是否阶梯:yes|no> <是否风暴:yes|no>
  local label="$1" ladder="$2" storm="$3"
  local dir="$WORK/$label"
  mkdir -p "$dir/sessions"
  local args=(--no-skills --no-context-files --thinking off --provider "$PROVIDER" --model "$MODEL")
  [ "$storm" = yes ] && args+=(-e "$EXT_FAKE")
  [ "$ladder" = yes ] && args+=(-e "$EXT_LADDER")
  echo "=== $label ==="
  local t0 t1 wall out
  t0=$(python3 -c 'import time;print(time.time())')
  out=$( cd "$dir" && timeout 1500 pi -p "${args[@]}" --session-dir "$dir/sessions" -- "$PROMPT" 2>&1 )
  t1=$(python3 -c 'import time;print(time.time())')
  wall=$(python3 -c "print(round($t1-$t0,1))")
  echo "$out" | tail -3
  echo "[$label] 墙钟 ${wall}s"
  # 工具体量与阶梯日志
  python3 "$PROJ/probe/session_report.py" "$label" "$dir/sessions" | tail -2
  LBL="$label" WALL="$wall" DIR="$dir" python3 - <<'PY' >> "$JSONL"
import json, os
rec = {"label": os.environ["LBL"], "wall_s": float(os.environ["WALL"]), "dir": os.environ["DIR"]}
log = os.path.join(os.environ["DIR"], ".pi-tool-ladder", "log.jsonl")
trig = os.path.join(os.environ["DIR"], "ladder-trigger.jsonl")
if os.path.exists(log):
    rows = [json.loads(l) for l in open(log)]
    p = [r for r in rows if r.get("trigger") == "before_provider_request"]
    rec["category"] = rows[-1].get("category")
    rec["routedBy"] = rows[-1].get("routedBy")
    rec["mounted"] = len(rows[-1].get("mounted") or [])
    rec["payloadTools"] = max([r.get("payloadTools") or 0 for r in p] or [0])
print(json.dumps(rec, ensure_ascii=False))
PY
}

echo "### A 原版 pi（本机真实配置：扩展 + 技能 + 上下文 + 全部工具）"
run A-original-real no no
echo "### B 原版 pi + 189 工具风暴（模拟以后装很多扩展/MCP）"
run B-original-storm no yes
echo "### C 阶梯 pi（同一真实配置）"
run C-ladder-real yes no
echo "### D 阶梯 pi + 189 工具风暴"
run D-ladder-storm yes yes

echo ""
echo "### 汇总（评估/out/ab-local.jsonl）"
python3 - "$JSONL" <<'PY'
import json, sys, os
rows = [json.loads(l) for l in open(sys.argv[1])]
print("| 配置 | 整进程墙钟 | 进提示词工具数 | 载荷工具数 | 类别 | 判定依据 |")
print("|---|---:|---:|---:|---|---|")
for r in rows:
    print(f"| {r['label']} | {r['wall_s']}s | {r.get('mounted','—')} | {r.get('payloadTools','—')} | {r.get('category','—')} | {r.get('routedBy','—')} |")
PY
