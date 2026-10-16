/**
 * 离线测评（不调用任何模型，纯确定性，可秒级重复）
 *
 *   1) 分类准确性：真实口吻提示 → 期望类别
 *   2) 任务覆盖度：常见任务需要的工具，是否还在该类别挂载集合里
 *   3) 决策开销：planMount 在 N 个工具上的单次耗时
 *
 * 用法：
 *   node --experimental-strip-types eval/offline-eval.ts [inventory.jsonl]
 *   默认读取 /tmp/pi-tool-ladder-e2e/control/sessions（E2E 的 189 工具对照会话）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bucketTools, classifyByKeywords, mergeConfig, planMount, DEFAULT_BUDGET } from "../ladder/core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, "..");

// ---------- 工具清单：从 pi 会话文件第一条 system 消息的 toolsAdded 读，权威且可复现 ----------
function newestSession(dir: string): string | null {
  let best: string | null = null;
  let bestM = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const m = statSync(p).mtimeMs;
        if (m > bestM) {
          bestM = m;
          best = p;
        }
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return best;
}

function inventory(dir: string): { name: string; chars: number }[] {
  const f = newestSession(dir);
  if (!f) throw new Error("找不到会话文件：" + dir);
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const d = JSON.parse(line) as { type?: string; message?: { role?: string; toolsAdded?: unknown[] } };
    if (d.type === "message" && d.message?.role === "system") {
      return (d.message.toolsAdded ?? []).map((t) => {
        const o = t as { name: string; description?: string; parameters?: unknown };
        return {
          name: o.name,
          chars: JSON.stringify({ name: o.name, description: o.description ?? "", parameters: o.parameters ?? {} }).length,
        };
      });
    }
  }
  throw new Error("会话文件里没有 system 消息：" + f);
}

const cfg = mergeConfig({}, JSON.parse(readFileSync(join(PROJ, "ladder/config.default.json"), "utf8")) as never);
cfg.budget = { ...DEFAULT_BUDGET, ...(cfg.budget ?? {}) };

const invDir = process.argv[2] ?? "/tmp/pi-tool-ladder-e2e/control/sessions";
const tools = inventory(invDir);
const { buckets, unbucketed } = bucketTools(tools as never, cfg);

// ---------- 1) 分类准确性 ----------
// 期望值按 config.default.json 的关键词表人工判定；标注 ambiguous 的不计入准确率。
const prompts: { text: string; expect: string; note?: string }[] = [
  { text: "帮我搜一下这个网页里写了什么", expect: "web" },
  { text: "联网查一下这个网址的内容", expect: "web" },
  { text: "搜索一下 GMP 附录的最新版本", expect: "web" },
  { text: "读一下这个文件，把配置改一下", expect: "fs" },
  { text: "跑一下这个脚本，看看报错", expect: "fs" },
  { text: "这个 repo 的目录结构是什么", expect: "fs" },
  { text: "这段代码哪里有问题", expect: "fs" },
  { text: "帮我重构这个模块", expect: "fs" },
  { text: "读一下这个报错日志", expect: "fs" },
  {
    text: "下载网页内容存到本地文件里",
    expect: "",
    note: "同时命中 web（下载网页）与 fs（文件），优先级让 fs 胜出——歧义样例，不计入准确率",
  },
  { text: "调用 mcp 的浏览器服务截个图", expect: "mcp" },
  { text: "开三个子智能体并行干活", expect: "agent" },
  { text: "把这件事委派给 subagent 去做", expect: "agent" },
  { text: "今天几号", expect: "general" },
  { text: "只回两个字：收到", expect: "general" },
  { text: "42", expect: "general" },
];

const cls: {
  text: string;
  expect: string;
  actual: string;
  hits: string[];
  ok: boolean | null;
  us: number;
}[] = [];
for (const p of prompts) {
  const t0 = process.hrtime.bigint();
  const r = classifyByKeywords(p.text, cfg);
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  const actual = r.score > 0 ? r.category : cfg.fallbackCategory;
  cls.push({
    text: p.text,
    expect: p.expect,
    actual,
    hits: r.hits,
    ok: p.expect ? actual === p.expect : null,
    us,
  });
}
const scored = cls.filter((c) => c.ok !== null);
const acc = scored.filter((c) => c.ok).length / scored.length;

// ---------- 2) 任务覆盖度 ----------
// 任务 → 需要的工具；用真实名称（来自上面的 189 工具清单里的真实工具）
const tasks: { task: string; needs: string; category: string }[] = [
  { task: "读文件内容", needs: "read", category: "fs" },
  { task: "改文件里的配置", needs: "edit", category: "fs" },
  { task: "写一个新文件", needs: "write", category: "fs" },
  { task: "跑一条命令", needs: "bash", category: "fs" },
  { task: "按名字找文件", needs: "find_files", category: "fs" },
  { task: "在仓库里搜字符串", needs: "grep", category: "fs" },
  { task: "联网搜索", needs: "web_search", category: "web" },
  { task: "抓网页正文", needs: "fetch_content", category: "web" },
  { task: "核对来源", needs: "source_check", category: "web" },
  { task: "操作 MCP 浏览器", needs: "mcp", category: "mcp" },
  { task: "跑 MCP 脚本", needs: "mcp_script", category: "mcp" },
  { task: "派子智能体", needs: "subagent", category: "agent" },
  { task: "等子智能体结果", needs: "subagent_wait", category: "agent" },
  { task: "跟子智能体通信", needs: "intercom", category: "agent" },
  { task: "跑 JS 片段", needs: "js", category: "general" },
];

const cover: {
  task: string;
  needs: string;
  right: string;
  okRight: boolean;
  wrongCat: string;
  okWrong: boolean;
  reason: string;
}[] = [];
const catIds = cfg.categories.map((c) => c.id);
for (const t of tasks) {
  const plan = planMount(tools as never, cfg, t.category, []);
  const okRight = plan.mounted.includes(t.needs);
  const wrongCat = t.category === "fs" ? "web" : "fs";
  const planWrong = planMount(tools as never, cfg, wrongCat, []);
  const okWrong = planWrong.mounted.includes(t.needs);
  const dropped =
    plan.dropped.find((d) => d.name === t.needs)?.reason ??
    (!plan.mounted.includes(t.needs) ? "未在任何类别（需 ladder_mount 显式挂载）" : "");
  cover.push({ task: t.task, needs: t.needs, right: t.category, okRight, wrongCat, okWrong, reason: dropped });
}

// ---------- 3) 决策开销 ----------
const N = 200;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) planMount(tools as never, cfg, catIds[i % catIds.length], []);
const perDecisionMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

// ---------- 输出 ----------
const out = {
  inventory: { source: invDir, tools: tools.length, chars: tools.reduce((a, b) => a + b.chars, 0) },
  buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  unbucketed: unbucketed.length,
  classify: { accuracy: acc, scored: scored.length, ambiguous: cls.filter((c) => c.ok === null).length, cases: cls },
  coverage: cover,
  overhead: { perDecisionMs, iterations: N },
};
mkdirSync(join(HERE, "out"), { recursive: true });
writeFileSync(join(HERE, "out", "offline.json"), JSON.stringify(out, null, 2) + "\n");

const bar = (ok: boolean | null) => (ok === null ? "—" : ok ? "✅" : "❌");
console.log(`工具清单：${invDir}`);
console.log(`  可用工具 ${tools.length} 个 / schema ${out.inventory.chars} 字符（≈${Math.round(out.inventory.chars / 4)} token）`);
console.log(`  分桶：${Object.entries(out.buckets).map(([k, v]) => k + "=" + v).join(" ")}｜未归桶 ${unbucketed.length}`);
console.log("");
console.log(`【1】分类准确性：${(acc * 100).toFixed(0)}%（${scored.filter((c) => c.ok).length}/${scored.length}，另 ${out.classify.ambiguous} 条歧义不计）`);
console.log("  结果  期望   实际   命中词                        提示");
for (const c of cls) {
  console.log(
    `  ${bar(c.ok)}   ${(c.expect || "-").padEnd(7)}${c.actual.padEnd(7)}${(c.hits.join("+") || "(无)").padEnd(30)}${c.text}`,
  );
}
console.log(`  单次判定耗时：${(cls.reduce((a, b) => a + b.us, 0) / cls.length).toFixed(0)} 微秒`);
console.log("");
console.log("【2】任务覆盖度（正确类别下是否已在挂载集合里）");
console.log("  结果  任务              需要的工具        类别    说明");
for (const c of cover) {
  console.log(
    `  ${bar(c.okRight)}   ${c.task.padEnd(16)}${c.needs.padEnd(17)}${c.right.padEnd(8)}${c.reason || ""}`,
  );
}
const missRight = cover.filter((c) => !c.okRight);
const missWrong = cover.filter((c) => !c.okWrong);
console.log("");
console.log(`  正确类别下缺工具：${missRight.length} 项 ${missRight.map((c) => c.needs).join(", ")}`);
console.log(`  错误类别下缺工具：${missWrong.length} 项 ${missWrong.map((c) => c.needs).join(", ")}`);
console.log("");
console.log(`【3】决策开销：${perDecisionMs.toFixed(2)} 毫秒/次（${N} 次 ${tools.length} 个工具）`);
