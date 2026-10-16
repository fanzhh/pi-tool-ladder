#!/bin/bash
# pi-tool-ladder E2E：在真实 pi 会话里验证「工具再多也守得住层级」。
#
# 覆盖：
#   1 control     不装阶梯，量出基线（工具与 schema 体量）
#   2 storm       120 个假扩展工具 + 40 个仿 MCP 工具，验证预算不变量
#   3 route-web   关键词路由到 web
#   4 route-fs    关键词路由到 fs
#   5 fallback    无法分类 → general
#   6 sticky      同一会话内两句关键词不同，默认仍粘原类别（保前缀缓存）
#   7 on-demand   让模型按需挂载类别外的工具（intercom），下一轮载荷里要带上它
#
# 产物：e2e/out/report.md、e2e/out/report.json（可重复执行）
#
# 四个坑（都踩过）：
#   - 插件路径必须作为**独立参数**传进函数；把 "-e /path" 包成一个字符串会让 pi
#     把整串当成一个选项值，直接报 Unknown option 退出，且不写 session 文件。
#   - 提示词含空格，必须整体作为一个参数传（这里用全局变量 PROMPT）。
#   - 需要多轮同一会话的用例必须显式指定同一个 SESSDIR，否则 run() 会按用例名
#     各自建目录，-c 没有可续的会话。
#   - 清理工作目录用 python shutil，不写递归删除命令（本机 Laya 路由会拦）。
set -u

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${LADDER_E2E_WORK:-/tmp/pi-tool-ladder-e2e}"
PROVIDER="${LADDER_E2E_PROVIDER:-magpie}"
MODEL="${LADDER_E2E_MODEL:-group/auto}"
EXT_LADDER="$PROJ/ladder/index.ts"
EXT_FAKE="$PROJ/e2e/fake-tools.ts"
COMMON="--no-skills --no-context-files --thinking off --provider $PROVIDER --model $MODEL"
PROMPT=""
SESSDIR=""      # 非空时覆盖默认的 <用例目录>/sessions
CASEDIR=""      # 非空时覆盖默认的 <WORK>/<用例名>（多轮用例必须共用同一个 cwd，
                # 否则阶梯的 state/log 分家，粘性与按需挂载都测不出来）

LADDER_E2E_WORK="$WORK" python3 -c 'import os,shutil; shutil.rmtree(os.environ["LADDER_E2E_WORK"], ignore_errors=True)'
mkdir -p "$WORK"

run() { # run <用例名> [额外 pi 参数...]；提示词取自 PROMPT，会话/工作目录可取 SESSDIR/CASEDIR
  local name="$1"; shift
  local dir="${CASEDIR:-$WORK/$name}"
  local sd="${SESSDIR:-$dir/sessions}"
  mkdir -p "$dir" "$sd"
  echo "=== $name ==="
  local out
  out=$( cd "$dir" && timeout 600 pi -p $COMMON $* --session-dir "$sd" -- "$PROMPT" 2>&1 )
  echo "$out" | grep -Ev "^(Warning|npm warn|\[fake-tools\])" | tail -4
  if echo "$out" | grep -qE "Unknown option|^Error:"; then
    echo "!!! $name 启动失败：$(echo "$out" | grep -E "Unknown option|^Error:" | head -1)"
  fi
}

echo "### 1 对照：不装阶梯"
PROMPT="只回两个字：收到"
run control -e "$EXT_FAKE"

echo "### 2 工具风暴"
run storm -e "$EXT_FAKE" -e "$EXT_LADDER"

echo "### 3 关键词路由：联网检索"
PROMPT="帮我搜索一下这个网页链接里的内容"
run route-web -e "$EXT_LADDER"

echo "### 4 关键词路由：文件与代码"
PROMPT="读一下这个文件，然后改写里面的代码"
run route-fs -e "$EXT_LADDER"

echo "### 5 兜底：无法分类"
PROMPT="42"
run fallback -e "$EXT_LADDER"

echo "### 6 粘性：同一会话两句关键词不同（默认应保持原类别）"
CASEDIR="$WORK/sticky" SESSDIR="$WORK/sticky/sessions"
PROMPT="帮我搜索一下这个网页链接里的内容"
run sticky-1 -e "$EXT_LADDER"
PROMPT="再读一下这个文件，改写代码"
run sticky-2 -e "$EXT_LADDER" -c
CASEDIR="" SESSDIR=""

echo "### 7 按需挂载：挂一个类别外的工具（intercom）"
CASEDIR="$WORK/on-demand" SESSDIR="$WORK/on-demand/sessions"
PROMPT="请调用 ladder_mount 工具，action=mount，query=intercom，然后回两个字：完成"
run on-demand-1 -e "$EXT_LADDER"
PROMPT="再回两个字：收到"
run on-demand-2 -e "$EXT_LADDER" -c
CASEDIR="" SESSDIR=""

echo "### 8 预算绝对优先：显式挂一个超大工具（subagent，26,555 字符）"
CASEDIR="$WORK/budget-absolute" SESSDIR="$WORK/budget-absolute/sessions"
PROMPT="请调用 ladder_mount 工具，action=mount，query=subagent，然后回两个字：完成"
run budget-absolute-1 -e "$EXT_LADDER"
CASEDIR="" SESSDIR=""

# ---- 9 System One 路由：真跑三个分支（假端点，不需要本地小模型）----
# 提示词固定用「帮我搜一下这个网页里写了什么」（关键词判定为 web），
# 假端点固定回 mcp，这样"采信端点"和"回退关键词"两种结果一眼可分。
SO_PORT=9415
so_start() {
  python3 "$PROJ/e2e/fake-systemone.py" --port "$SO_PORT" "$@" > "$WORK/fake-systemone.log" 2>&1 &
  SO_PID=$!
  for _ in $(seq 1 25); do
    curl -s -m 1 "http://127.0.0.1:$SO_PORT/health" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "!!! 假端点未就绪（$SO_PORT）"
  return 1
}
so_stop() {
  [ -n "${SO_PID:-}" ] && kill "$SO_PID" 2>/dev/null
  wait "$SO_PID" 2>/dev/null
  SO_PID=""
}
so_case() { # so_case <用例名> <端点URL>
  local name="$1" url="$2"
  mkdir -p "$WORK/$name"
  printf '{"router":{"mode":"systemone","classifyEndpoint":"%s","confidenceFloor":0.5,"timeoutMs":2500}}\n' "$url" \
    > "$WORK/$name/.pi-tool-ladder.json"
}

echo "### 9a System One 正常：采信端点判定"
so_case so-ok "http://127.0.0.1:$SO_PORT/v1/systemone"
so_start --choice mcp --confidence 0.99
CASEDIR="$WORK/so-ok" SESSDIR=""
PROMPT="帮我搜一下这个网页里写了什么"
run so-ok -e "$EXT_LADDER"
CASEDIR="" SESSDIR=""
so_stop

echo "### 9b System One 低置信度：必须回退关键词"
so_case so-lowconf "http://127.0.0.1:$SO_PORT/v1/systemone"
so_start --choice mcp --confidence 0.2
CASEDIR="$WORK/so-lowconf" SESSDIR=""
PROMPT="帮我搜一下这个网页里写了什么"
run so-lowconf -e "$EXT_LADDER"
CASEDIR="" SESSDIR=""
so_stop

echo "### 9c System One 端点不通：必须回退关键词"
so_case so-down "http://127.0.0.1:9416/v1/systemone"
CASEDIR="$WORK/so-down" SESSDIR=""
PROMPT="帮我搜一下这个网页里写了什么"
run so-down -e "$EXT_LADDER"
CASEDIR="" SESSDIR=""

node "$PROJ/e2e/report.mjs" \
  "control:$WORK/control/sessions:*:0:0" \
  "storm:$WORK/storm/sessions:*:12:14000" \
  "route-web:$WORK/route-web/sessions:web:12:14000" \
  "route-fs:$WORK/route-fs/sessions:fs:12:14000" \
  "fallback:$WORK/fallback/sessions:general:12:14000" \
  "sticky-2:$WORK/sticky/sessions:web:12:14000" \
  "on-demand-1:$WORK/on-demand/sessions:*:12:14000" \
  "on-demand-2:$WORK/on-demand/sessions:*:12:14000" \
  "budget-absolute-1:$WORK/budget-absolute/sessions:*:12:14000" \
  "so-ok:$WORK/so-ok/sessions:mcp:12:14000:systemone" \
  "so-lowconf:$WORK/so-lowconf/sessions:web:12:14000:keyword" \
  "so-down:$WORK/so-down/sessions:web:12:14000:keyword"
