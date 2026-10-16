# DEV_STATE

只记已确认事实（命令、结果、结论）。不贴代码、不写密钥。

## 2026-10-16 建立

- 项目位置：`/Users/mac/projects/pi-tool-ladder`，独立 git 仓库。
- 目标：让 Pi 的工具 / MCP / 扩展无论以后增加多少，进提示词的永远是受预算约束的一小撮。
- 依赖：`typebox@^1.1.24`（本地安装）。注意包名是 `typebox`（不是 `@sinclair/typebox`），Pi 自己依赖该包 `^1.1.24`；外部扩展通过 `pi -e <绝对路径>` 加载时需要自己有这份依赖。

### 已验证的 Pi 机制（用探针实测）

- `pi.getAllTools()` / `pi.getActiveTools()` / `pi.setActiveTools(names)` 可用；在 `before_agent_start` 里调用后，默认 27 个活动工具可压到 1 个。
- `before_provider_request` 能拿到并替换 provider 载荷；载荷形状（OpenAI 兼容）：
  `{ model, messages, stream, prompt_cache_key, ..., tools: [{ type: "function", function: { name, description, parameters } }] }`。
- 实测载荷工具量与 schema 体量（`--no-skills --no-context-files`，magpie/group/auto）：
  - 不干预：29 个工具 / 60,769 字符
  - 探针只挂 `read`：3 个工具（read、js、js_reset）/ 3,180 字符
  - 说明：另有扩展会在我们之后把工具加回（`js`、`js_reset`），所以最终必须在**载荷层**再收一次。
- 会话文件 `~/.pi/agent/sessions/<项目>/<时间>.jsonl` 的第一条 system 消息里有
  `sections`（系统提示各节）与 `toolsAdded`（当次请求的工具 schema），可作为"进了多少提示词"的权威证据。

### 阶梯行为（本地冒烟，196 个可用工具时）

- 可用工具 196 个（120 假扩展 + 40 仿 MCP + 36 真实扩展）；分桶 `fs=8 web=4 mcp=2 agent=3 general=2`，未归桶 177。
- 挂载 5 个工具 / 4,438 字符（预算 12 工具 / 14,000 字符），压掉 175 个。
- 载荷层：原 7 个工具 / 7,050 字符 → 收紧为 5 个 / 4,599 字符。

### E2E

- `bash e2e/run.sh`：真跑 8 次 pi 会话，产物 `e2e/out/report.md` + `report.json`，断言失败返回非 0。
- 踩坑 1：函数参数里把 `-e /path` 包成一个字符串 → pi 报 `Unknown option` 且不写 session 文件；必须拆成独立参数。
- 踩坑 2：提示词含空格，必须整体作为一个参数传。
- 踩坑 3：`session_start` 里若把兜底类别写进 state，首句提示词的关键词路由永远不生效；只应用不落盘。
