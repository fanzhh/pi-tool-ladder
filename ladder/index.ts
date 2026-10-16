/**
 * pi-tool-ladder —— 让 Pi 的工具 / MCP / 扩展再多，进提示词的也永远是一小撮。
 *
 * 三层阶梯：
 *   L1 类别：整个会话粘一个类别（关键词判断，缺省粘住以保住前缀缓存）
 *   L2 子集：类别内按顺序取，受每类 maxTools 限制
 *   L3 按需：ladder_mount 工具可以随时列出/搜索/挂载任何未挂载的工具
 *
 * 硬不变量（由 before_provider_request 在载荷层强制）：
 *   实际请求里的工具数 ≤ budget.maxTools，schema 字符数 ≤ budget.maxSchemaChars；
 *   未归桶的新工具默认一个都不挂（budget.maxUnbucketed）。
 *   因此将来再加多少扩展/MCP，都不会把提示词顶爆。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGET,
  bucketTools,
  classifyByKeywords,
  hashConfig,
  mergeConfig,
  planMount,
  type Decision,
  type LadderConfig,
  type ToolInfo,
} from "./core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAG = "[ladder]";

function log(msg: string): void {
  console.log(TAG + " " + msg);
}

function loadConfig(cwd: string): LadderConfig {
  const base = JSON.parse(readFileSync(join(HERE, "config.default.json"), "utf8")) as LadderConfig;
  base.budget = { ...DEFAULT_BUDGET, ...(base.budget ?? {}) };

  const candidates = [
    process.env.PI_LADDER_CONFIG,
    join(cwd, ".pi-tool-ladder.json"),
    join(process.env.HOME ?? "", ".pi/agent/tool-ladder.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LadderConfig>;
      log("合并用户配置 " + p);
      return mergeConfig(raw, base);
    } catch {
      /* 不存在或读不动就跳过，保持默认 */
    }
  }
  return base;
}

interface LadderState {
  category?: string;
  extra?: string[];
  updatedAt?: string;
}

function readState(file: string, sessionId: string): LadderState {
  try {
    const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, LadderState>;
    return all[sessionId] ?? {};
  } catch {
    return {};
  }
}

function writeState(file: string, sessionId: string, st: LadderState): void {
  let all: Record<string, LadderState> = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8")) as Record<string, LadderState>;
  } catch {
    all = {};
  }
  all[sessionId] = { ...st, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
}

function measure(t: {
  name: string;
  description?: string;
  parameters?: unknown;
  sourceInfo?: { source?: string };
}): ToolInfo {
  const chars = JSON.stringify({
    name: t.name,
    description: t.description ?? "",
    parameters: t.parameters ?? {},
  }).length;
  return { name: t.name, chars, source: t.sourceInfo?.source };
}

export default function toolLadder(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const cfgHash = hashConfig(cfg);
  const logFile = resolve(cwd, cfg.logPath);
  const stateFile = resolve(cwd, cfg.statePath);

  // 跨进程稳定的会话标识：优先用 pi 的 session 文件路径（-c 续会话时同一个文件），
  // 取不到才退化为 cwd。用 Date.now() 之类的临时值会让"粘性"和"按需挂载"跨进程失效。
  let sessionId = "cwd:" + cwd;
  const refreshSessionId = (ctx: unknown): string => {
    const env = process.env.PI_LADDER_SESSION;
    if (env) {
      sessionId = env;
      return sessionId;
    }
    try {
      const f = (ctx as { sessionManager?: { getSessionFile?: () => string | null | undefined } })
        ?.sessionManager?.getSessionFile?.();
      if (f) sessionId = String(f);
    } catch {
      /* 保持原值 */
    }
    return sessionId;
  };

  let pendingCategory: { category: string; score: number; hits: string[] } | null = null;
  let lastDecision: Decision | null = null;
  let lastPromptChars = 0;

  const allTools = (): ToolInfo[] => pi.getAllTools().map((t) => measure(t as never));

  const decide = (routedBy: string, category: string, score = 0): Decision => {
    const tools = allTools();
    const st = readState(stateFile, sessionId);
    const extra = st.extra ?? [];
    const d = planMount(tools, cfg, category, extra);
    d.routedBy = routedBy;
    d.score = score;
    lastDecision = d;
    return d;
  };

  const pickCategory = (prompt: string): { category: string; routedBy: string; score: number } => {
    const env = process.env.PI_LADDER_CATEGORY;
    if (env) return { category: env, routedBy: "env:PI_LADDER_CATEGORY", score: 0 };

    const st = readState(stateFile, sessionId);
    const known = cfg.categories.some((c) => c.id === st.category);
    if (st.category && known && cfg.router.sticky === "session") {
      return { category: st.category, routedBy: "sticky:session", score: 0 };
    }
    const cls = classifyByKeywords(prompt || "", cfg);
    if (cfg.router.sticky === "keyword" && known) {
      // 关键词模式：新类别得分更高才切，避免来回抖动
      if (cls.score > 0) return { category: cls.category, routedBy: "keyword", score: cls.score };
      return { category: st.category as string, routedBy: "sticky:keyword", score: 0 };
    }
    return { category: cls.category, routedBy: cls.score > 0 ? "keyword" : "fallback", score: cls.score };
  };

  const apply = (d: Decision, why: string): void => {
    pi.setActiveTools(d.mounted);
    const active = pi.getActiveTools().length;
    log(
      `category=${d.category} by=${d.routedBy} mounted=${d.mounted.length}(active=${active}) ` +
        `chars=${d.mountedChars}/${cfg.budget.maxSchemaChars} ` +
        `dropped=${d.dropped.length} unbucketed=${d.unbucketed.length} ${why}`,
    );
  };

  const record = (extra: Record<string, unknown>): void => {
    try {
      const d = lastDecision;
      const line = {
        ts: new Date().toISOString(),
        sessionId,
        cwd,
        configHash: cfgHash,
        category: d?.category ?? null,
        routedBy: d?.routedBy ?? null,
        score: d?.score ?? 0,
        mounted: d?.mounted ?? [],
        mountedChars: d?.mountedChars ?? 0,
        droppedCount: d?.dropped?.length ?? 0,
        buckets: d?.buckets ?? {},
        unbucketed: d?.unbucketed ?? [],
        budget: cfg.budget,
        ...extra,
      };
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, JSON.stringify(line) + "\n");
    } catch (e) {
      log("写日志失败（忽略）：" + String(e));
    }
  };

  // ---------- 阶梯自己的两个小工具（schema 很小，始终可挂） ----------
  pi.registerTool({
    name: "ladder_status",
    label: "Ladder status",
    description:
      "查看本会话的工具阶梯状态：当前类别、已挂载工具、被压下的工具数量与分桶统计。" +
      "当你不确定某个工具为什么不可用时用它。",
    parameters: Type.Object({}),
    async execute() {
      const tools = allTools();
      const { buckets, unbucketed } = bucketTools(tools, cfg);
      const d = lastDecision;
      const text = [
        `类别: ${d?.category ?? "(未定)"}（由 ${d?.routedBy ?? "-"} 决定）`,
        `已挂载(${d?.mounted.length ?? 0}): ${(d?.mounted ?? []).join(", ")}`,
        `预算: 工具≤${cfg.budget.maxTools}，schema≤${cfg.budget.maxSchemaChars} 字符`,
        `分桶: ${Object.entries(buckets).map(([k, v]) => k + "=" + v.length).join(" ")}`,
        `未归桶(${unbucketed.length}): ${unbucketed.map((t) => t.name).join(", ") || "无"}`,
        `可用工具总数: ${tools.length}`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "ladder_mount",
    label: "Ladder mount",
    description:
      "按需挂载/卸下工具：action=list 列出全部可用工具；action=search 按关键词找；" +
      "action=mount 挂载指定工具（可用逗号分隔多个）；action=unmount 卸下。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("search"),
        Type.Literal("mount"),
        Type.Literal("unmount"),
      ]),
      query: Type.Optional(
        Type.String({ description: "search 的关键词，或 mount/unmount 的工具名（逗号分隔）" }),
      ),
    }),
    async execute(_id, params) {
      const { action, query } = params as { action: string; query?: string };
      const tools = allTools();
      const { buckets } = bucketTools(tools, cfg);
      const st = readState(stateFile, sessionId);
      const extra = new Set(st.extra ?? []);

      const render = () =>
        tools
          .map((t) => `${t.name}${(lastDecision?.mounted ?? []).includes(t.name) ? " [已挂载]" : ""}`)
          .join("\n");

      if (action === "list") {
        return {
          content: [
            {
              type: "text",
              text:
                `可用工具 ${tools.length} 个：\n` +
                render() +
                `\n\n分桶：${Object.entries(buckets).map(([k, v]) => k + "=" + v.length).join(" ")}`,
            },
          ],
        };
      }
      if (action === "search") {
        const q = (query ?? "").toLowerCase();
        const hits = tools.filter((t) => t.name.toLowerCase().includes(q));
        return {
          content: [
            {
              type: "text",
              text: hits.length
                ? hits.map((t) => `${t.name}（${t.chars} 字符）`).join("\n")
                : "没有匹配的工具",
            },
          ],
        };
      }

      const names = (query ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!names.length) return { content: [{ type: "text", text: "请给出工具名（逗号分隔）" }] };
      const missing: string[] = [];
      for (const n of names) {
        const t = tools.find((x) => x.name === n);
        if (!t) {
          missing.push(n);
          continue;
        }
        if (action === "mount") extra.add(n);
        else extra.delete(n);
      }
      writeState(stateFile, sessionId, { ...st, extra: [...extra] });
      const d = decide("tool:ladder_mount", lastDecision?.category ?? cfg.fallbackCategory);
      apply(d, "ladder_mount " + action);
      record({ trigger: "ladder_mount", action, names });
      return {
        content: [
          {
            type: "text",
            text:
              `${action} 完成。当前挂载(${d.mounted.length}): ${d.mounted.join(", ")}` +
              (missing.length ? `\n不存在的工具：${missing.join(", ")}` : ""),
          },
        ],
      };
    },
  });

  // ---------- 命令 ----------
  pi.registerCommand("ladder", {
    description: "查看工具阶梯状态",
    handler: async (_args, ctx) => {
      refreshSessionId(ctx);
      const d = lastDecision;
      ctx.ui.notify(
        d ? `类别 ${d.category}｜挂载 ${d.mounted.length} 个｜${d.mountedChars} 字符` : "尚无决策",
        "info",
      );
    },
  });

  pi.registerCommand("cat", {
    description: "切换工具类别：/cat fs|web|mcp|agent|general",
    handler: async (args, ctx) => {
      refreshSessionId(ctx);
      const id = (args ?? "").trim();
      if (!cfg.categories.some((c) => c.id === id)) {
        ctx.ui.notify("可用类别：" + cfg.categories.map((c) => c.id).join(", "), "warning");
        return;
      }
      writeState(stateFile, sessionId, { ...readState(stateFile, sessionId), category: id });
      const d = decide("command:/cat", id);
      apply(d, "命令切换");
      record({ trigger: "command:/cat", category: id });
      ctx.ui.notify(`已切到类别 ${id}（挂载 ${d.mounted.length} 个工具）`, "info");
    },
  });

  // ---------- 生命周期 ----------
  pi.on("session_start", async (_event, ctx) => {
    refreshSessionId(ctx);
    const tools = allTools();
    const { buckets, unbucketed } = bucketTools(tools, cfg);
    log(
      `session_start key=${sessionId} 可用工具=${tools.length} 分桶=${JSON.stringify(
        Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
      )} 未归桶=${unbucketed.length} 预算=${cfg.budget.maxTools}工具/${cfg.budget.maxSchemaChars}字符`,
    );
    const st = readState(stateFile, sessionId);
    const d = decide("session_start", st.category ?? cfg.fallbackCategory);
    apply(d, "会话开始");
    // 注意：这里不写 state。否则首句提示词会被兜底类别钉死，关键词路由永远不生效。
  });

  pi.on("input", async (event, ctx) => {
    refreshSessionId(ctx);
    const text = (event as { text?: string }).text ?? "";
    lastPromptChars = text.length;
    pendingCategory = classifyByKeywords(text, cfg);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    refreshSessionId(ctx);
    const prompt = (event as { prompt?: string }).prompt ?? "";
    const picked = pickCategory(prompt);
    const d = decide(picked.routedBy, picked.category, picked.score);
    const before = pi.getActiveTools().length;
    apply(d, `prompt=${lastPromptChars}字符`);
    if (before !== d.mounted.length) {
      record({
        trigger: "before_agent_start",
        changed: `${before}->${d.mounted.length}`,
        keywordHits: pendingCategory?.hits ?? [],
      });
    }
    writeState(stateFile, sessionId, { ...readState(stateFile, sessionId), category: d.category });
  });

  // 硬不变量：载荷层再收一次，别的扩展事后加工具也顶不破预算
  pi.on("before_provider_request", (event, ctx) => {
    try {
      refreshSessionId(ctx);
      const payload = event.payload as Record<string, unknown>;
      const raw = payload.tools;
      if (!Array.isArray(raw)) {
        record({ trigger: "before_provider_request", payloadTools: 0 });
        return undefined;
      }
      const mounted = lastDecision?.mounted ?? [];
      const keep = raw.filter((t) => {
        const n =
          (t as { function?: { name?: string }; name?: string }).function?.name ??
          (t as { name?: string }).name ??
          "";
        return mounted.includes(n) || cfg.controlTools.includes(n);
      });
      const payloadChars = JSON.stringify(keep).length;
      record({
        trigger: "before_provider_request",
        payloadTools: keep.length,
        payloadChars,
        payloadRawTools: raw.length,
        payloadRawChars: JSON.stringify(raw).length,
      });
      if (keep.length === 0 || keep.length === raw.length) return undefined;
      return { ...payload, tools: keep };
    } catch (e) {
      log("载荷收紧失败（放行原载荷）：" + String(e));
      return undefined;
    }
  });
}
