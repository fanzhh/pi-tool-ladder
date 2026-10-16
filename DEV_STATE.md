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

### 设计决定：预算绝对优先（2026-10-16，用户拍板）

- `maxTools` / `maxSchemaChars` 不可被任何请求突破，**包括 `ladder_mount` 显式挂载的大工具**。
- 装入顺序即优先级：alwaysOn → 阶梯控制工具 → 按需挂载 → 类别自动填充 → 未归桶；超预算的从后往前丢，
  记入 `dropped`，显式挂载被丢时原因写明"预算绝对优先"。
- 实测（E2E 用例 `budget-absolute`）：让模型显式挂 `subagent`（26,555 字符 > 预算 14,000）→
  state 记录了该请求，但**没挂上**；提示词仍是 8 个工具 / 8,973 字符，没有破预算。
  同一轮里更小的同类工具（`subagent_supervisor` 466、`subagent_wait` 2,047）照常挂上。

### 测评发现与加固（2026-10-17）

三套评测脚本：`eval/offline-eval.ts`（离线确定性）、`eval/ab-local.sh`（本地 A/B）、`eval/misroute.sh`（误分类恢复）。

评测发现的两个缺口，**已修一个、待修一个**：

1. **已修**：模型拿不到工具时会剧烈空转。修复前实测：误分类后要 `subagent`（超预算）→ 连调
   `ladder_mount` **18 次**（挂/卸反复、试 `codemode` 沙箱与 `tool_search` 顶替），约 30 次 provider 请求，
   最终反问用户。原因就是 `ladder_mount` 返回值只说「完成」。加固三件事：
   - 返回值明确写「谁没挂上、为什么（字符数 vs 预算）、请勿重试」，并给替代路径；
   - `alwaysOn` 工具拒绝被 `unmount`；
   - 新增 `action=category`，模型可自己换类别（等价 `/cat`）。
   修复后同样的失败场景：**18 次 → 3 次**调用，且模型**主动用了新的 category 逃生口**，最后用 `read` 把活干完
   并说明原因。
2. **待修**：`categories[].patterns` 的**顺序目前不生效**——`planMount` 按工具注册顺序切片，
   不是按 `patterns` 顺序取。导致 `fs` 类别里 `write` 被 `maxTools=6` 挤掉（覆盖度实测 15 项里缺
   `write`、`subagent`、`js`）。修法：按 `patterns` 逐条展开匹配再切片。

其余实测结论（提示词体量 96.3% 压缩、本地墙钟 2.3×/8.2×、分类 15/15、决策 0.09ms）见
`2026-10-17-pi-tool-ladder-review-vs-vanilla-pi.md`。

### E2E

- `bash e2e/run.sh`：真跑 11 次 pi 会话，产物 `e2e/out/report.md` + `report.json`，断言失败返回非 0。
  2026-10-16 最近一次：**全部通过（EXIT=0）**。
- 踩坑 1：函数参数里把 `-e /path` 包成一个字符串 → pi 报 `Unknown option` 且不写 session 文件；必须拆成独立参数。
- 踩坑 2：提示词含空格，必须整体作为一个参数传。
- 踩坑 3：`session_start` 里若把兜底类别写进 state，首句提示词的关键词路由永远不生效；只应用不落盘。
- 踩坑 4：会话标识若用 `Date.now()`，跨进程粘性与按需挂载全失效；改用 `ctx.sessionManager.getSessionFile()`。
- 踩坑 5：多轮用例必须共用同一个 cwd，否则阶梯的 state/log 分家。
