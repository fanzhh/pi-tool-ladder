#!/bin/bash
# 误分类恢复测试：类别粘错了，模型能不能自己救回来？
#
# 场景：先在会话里说一句联网检索的话 → 类别粘在 web；然后同一会话改口要干文件活儿。
# 观察：模型是否会调用 ladder_mount 挂上缺的工具，以及最终有没有把活儿干完。
# 这一条是整个设计最大的风险点，必须实测，不能靠推理。
#
# 产物：eval/out/misroute.md、eval/out/misroute.jsonl
set -u

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${MR_WORK:-/tmp/pi-tool-ladder-misroute}"
PROVIDER="${MR_PROVIDER:-magpie}"
MODEL="${MR_MODEL:-group/auto}"
EXT_LADDER="$PROJ/ladder/index.ts"
OUT="$PROJ/eval/out"
JSONL="$OUT/misroute.jsonl"

MR_WORK="$WORK" python3 -c 'import os,shutil; shutil.rmtree(os.environ["MR_WORK"], ignore_errors=True)'
mkdir -p "$WORK" "$OUT" "$WORK/proj"
: > "$JSONL"
# 给"文件活儿"准备一个真文件，让模型有东西可改
printf 'name: demo\nport: 8080\n' > "$WORK/proj/demo.yaml"

run() { # run <标签> <提示词> <是否续会话:yes|no>
  local label="$1" prompt="$2" cont="$3"
  local args=(--no-skills --no-context-files --thinking off --provider "$PROVIDER" --model "$MODEL" -e "$EXT_LADDER")
  [ "$cont" = yes ] && args+=(-c)
  echo "=== $label ==="
  ( cd "$WORK/proj" && timeout 600 pi -p "${args[@]}" --session-dir "$WORK/sessions" -- "$prompt" 2>&1 ) | grep -Ev "^(Warning|npm warn)" | tail -12
}

echo "### 第 1 句：把类别粘到 web"
run 粘类别 "帮我搜一下这个网页里的内容" no

echo "### 第 2 句（同一会话）：改口干文件活，且只给 web 类别的工具"
run 误分类后干文件活 "把 demo.yaml 里的端口改成 9090，改完告诉我新端口号" yes

echo "### 第 3 句（同一会话）：要子智能体（agent 类别，且 subagent schema 超预算）"
run 误分类后要子智能体 "派一个子智能体去统计 demo.yaml 有几行，把结果告诉我" yes

LBL=misroute WORK="$WORK" python3 - <<'PY' >> "$JSONL"
import json, os
d = os.path.join(os.environ["WORK"])
log = os.path.join(d, "proj", ".pi-tool-ladder", "log.jsonl")
rec = {"label": os.environ["LBL"], "log": log}
if os.path.exists(log):
    rows = [json.loads(l) for l in open(log)]
    rec["decisions"] = [
        {"trigger": r.get("trigger"), "category": r.get("category"), "routedBy": r.get("routedBy"),
         "mounted": r.get("mounted"), "action": r.get("action"), "names": r.get("names"),
         "payloadTools": r.get("payloadTools")}
        for r in rows
    ]
print(json.dumps(rec, ensure_ascii=False))
PY

echo ""
echo "### 阶梯决策与恢复动作"
python3 - "$JSONL" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
recs = rows[0].get("decisions") or []
print("| # | 触发 | 类别 | 判定依据 | 挂载工具数 | 按需挂载动作 | 载荷工具数 |")
print("|---|---|---|---|---:|---|---:|")
for i, r in enumerate(recs, 1):
    act = "-"
    if r.get("trigger") == "ladder_mount":
        act = f"{r.get('action')} {','.join(r.get('names') or [])}"
    print(f"| {i} | {r.get('trigger')} | {r.get('category')} | {r.get('routedBy')} | {len(r.get('mounted') or [])} | {act} | {r.get('payloadTools','-')} |")
print("")
mounts = [r for r in recs if r.get("trigger") == "ladder_mount"]
print(f"模型自发调用 ladder_mount 次数：{len(mounts)}；动作：{'; '.join((r.get('action') or '') + ' ' + ','.join(r.get('names') or []) for r in mounts) or '无'}")
PY
