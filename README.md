# pi-tool-ladder

让 Pi 的工具、MCP、扩展**无论以后增加多少**，真正进提示词的永远是一小撮。

## 为什么需要它

在本机实测（见 `knowledge1/01_AREAS/projects/active/local-ai-inference/2026-10-16-mini6-qwen3.8-27b-slim-pi-agent-vision-ocr-benchmark.md`）：

- 默认配置下 Pi 的活动工具 27–29 个，工具 schema **62,464 字符 ≈ 15,616 token**；
- 加到本地 27B 模型上，提示词 27,217 token，单轮读入 143.5 秒（整进程 173 秒）；
- 而精简到只挂 `read` 时，工具 schema 降到 3,180 字符，提示词 1,525 token，整进程 21 秒；
- 每条提示词 token 还要在推理机内存里留 KV，约 **179 MB / 1,000 token**。

也就是说：**工具越多，首轮越慢、内存越紧**，而日常一轮只用到其中几个。

## 三层阶梯

| 层 | 作用 | 实现 |
|---|---|---|
| **L1 类别** | 整个会话粘一个类别，避免每轮换类别砸掉前缀缓存 | `classifyByKeywords` + state 文件（`sticky: session`） |
| **L2 子集** | 类别内按顺序取工具，受每类 `maxTools` 限制 | `planMount` |
| **L3 按需** | 任意未挂载工具随时可列出/搜索/挂载 | `ladder_status`、`ladder_mount` 两个小工具 |

## 硬不变量（这是"以后再多也守得住"的部分）

1. **未归桶的新工具默认一个都不挂**（`budget.maxUnbucketed: 0`）。新装一个扩展、新增一个 MCP server，它的工具会自动落进"未归桶"，**不会**自己挤进提示词。要用就显式归到某个类别，或临时 `ladder_mount`。
2. **预算双闸**：`maxTools`（工具个数）与 `maxSchemaChars`（schema 字符数），`planMount` 里按序贪心装入，超了就丢并记入 `dropped`。
3. **载荷层再收一次**：`before_provider_request` 直接过滤 provider 载荷里的 `tools`。即使别的扩展在我们之后又把工具塞回来，实际请求也不会超预算。

## 用法

```bash
# 临时试用
pi -e /Users/mac/projects/pi-tool-ladder/ladder/index.ts

# 常驻：加进 ~/.pi/agent/settings.json 的 extensions 数组
#   "extensions": ["+extensions/local-model/index.ts", "/Users/mac/projects/pi-tool-ladder/ladder/index.ts"]
```

会话内：

- `/ladder` 看当前类别与挂载数量
- `/cat web` 手动切类别（也可用环境变量 `PI_LADDER_CATEGORY=web`，便于脚本）
- 模型可自行调用 `ladder_status` / `ladder_mount`

### 配置

优先级：`PI_LADDER_CONFIG` > `<cwd>/.pi-tool-ladder.json` > `~/.pi/agent/tool-ladder.json` > 内置 `ladder/config.default.json`。

```json
{
  "budget": { "maxTools": 12, "maxSchemaChars": 14000, "maxUnbucketed": 0 },
  "alwaysOn": ["read"],
  "router": { "mode": "keyword", "sticky": "session" },
  "categories": [
    { "id": "web", "label": "联网检索", "priority": 20,
      "keywords": ["搜索", "网页", "url"],
      "patterns": ["web_search", "fetch_content"],
      "maxTools": 5 }
  ]
}
```

`patterns` 支持完全匹配、`前缀*`、`*后缀`、`*包含*`。新增扩展后，把它的工具名加进某个类别（或写 `前缀*`）即可自动纳入；不加则留在未归桶，永不影响预算。

## E2E

```bash
bash e2e/run.sh          # 真跑 8 次 pi 会话（默认走 magpie，可换本地模型）
```

覆盖：基线对照、120 + 40 个假工具的"工具风暴"、关键词路由（web / fs）、无法分类兜底、会话内粘性、按需挂载。产物：`e2e/out/report.md` 与 `report.json`，任一断言失败即非 0 退出。

换本地模型验证真实提示词体量：

```bash
LADDER_E2E_PROVIDER=ollama LADDER_E2E_MODEL=qwen3.8:27b-mlx bash e2e/run.sh
```

## 设计取舍

- **为什么默认粘住类别**：实测切到没用过的工具集要整条提示词重算（5,316 token / 24 秒），而切回用过的工具集几乎免费（0.32 秒）。所以"少切、切了就别来回切"。
- **为什么不在每轮都重新分类**：每轮换类别等于每轮丢缓存，比不分类更慢。
- **为什么给未归桶设 0**：这是唯一能保证"以后扩展暴涨也不会拖慢 Pi"的开关。
- **分类故意不用模型**：关键词匹配确定性、零延迟、可预测；留了 `router.classifyEndpoint` 位置，需要时再接本地 System One。
