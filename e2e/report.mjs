/**
 * E2E 断言器：读 session 文件与 ladder 日志，验证不变量与路由行为。
 * 用法：node e2e/report.mjs <out.jsonl汇总路径> <case1:dir1:期望类别> ...
 * 打印报告并写出 e2e/out/report.md、report.json；任一断言失败以非 0 退出。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

function newestSession(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".jsonl")) files.push(p);
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function systemMessage(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (d?.type === "message" && d.message?.role === "system") {
      const tools = d.message.toolsAdded ?? [];
      const chars = tools.reduce((s, t) => s + JSON.stringify(t).length, 0);
      return { count: tools.length, chars, names: tools.map((t) => t.name) };
    }
  }
  return null;
}

function ladderRecords(dir) {
  const p = join(dir, ".pi-tool-ladder", "log.jsonl");
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const cases = process.argv.slice(2).map((spec) => {
  const [name, dir, expectCategory, budgetTools, budgetChars, expectRoutedBy] = spec.split(":");
  // spec 里的 dir 通常是 sessions 目录；阶梯的日志/状态写在它的上一级
  const caseDir = dir.endsWith("/sessions") ? dirname(dir) : dir;
  return {
    name,
    dir,
    caseDir,
    expectCategory,
    budgetTools: Number(budgetTools),
    budgetChars: Number(budgetChars),
    expectRoutedBy: expectRoutedBy || "",
  };
});

const results = [];
let failed = 0;

for (const c of cases) {
  const file = newestSession(c.dir);
  const sys = file ? systemMessage(file) : null;
  const recs = ladderRecords(c.caseDir);
  const last = recs[recs.length - 1] ?? null;
  const payloadRecs = recs.filter((r) => r.trigger === "before_provider_request");
  const maxPayloadTools = Math.max(0, ...payloadRecs.map((r) => r.payloadTools ?? 0));
  const maxPayloadChars = Math.max(0, ...payloadRecs.map((r) => r.payloadChars ?? 0));
  const stateExtras = (() => {
    try {
      const all = JSON.parse(readFileSync(join(c.caseDir, ".pi-tool-ladder", "state.json"), "utf8"));
      return Object.values(all).flatMap((v) => v.extra ?? []);
    } catch {
      return [];
    }
  })();

  const checks = [];
  const check = (label, ok, detail) => {
    checks.push({ label, ok, detail });
    if (!ok) failed++;
  };
  const budgeted = Number.isFinite(c.budgetTools) && c.budgetTools > 0;

  check("会话文件存在", Boolean(file), file ?? "未找到");
  check("系统消息里有工具清单", Boolean(sys), sys ? `${sys.count} 个` : "无");
  if (sys && budgeted) {
    check(
      `进提示词的工具数 ≤ ${c.budgetTools}`,
      sys.count <= c.budgetTools,
      `实际 ${sys.count}（${sys.names.slice(0, 12).join(", ")}${sys.count > 12 ? "…" : ""}）`,
    );
    check(
      `进提示词的 schema 字符 ≤ ${c.budgetChars}`,
      sys.chars <= c.budgetChars,
      `实际 ${sys.chars} 字符`,
    );
  } else if (sys) {
    check("对照用例：只测量不设限", true, `${sys.count} 个工具 / ${sys.chars} 字符（基线）`);
  }
  if (c.name.startsWith("control")) {
    check("对照用例：不装阶梯，故无阶梯日志", recs.length === 0, `日志 ${recs.length} 条`);
  } else {
    check("阶梯写下了决策日志", recs.length > 0, `${recs.length} 条`);
  }
  if (maxPayloadTools > 0 && budgeted) {
    check(
      `载荷层工具数 ≤ ${c.budgetTools}`,
      maxPayloadTools <= c.budgetTools,
      `载荷最多 ${maxPayloadTools} 个 / ${maxPayloadChars} 字符`,
    );
  }
  // so-* 用例测的是"本轮路由怎么决定的"，取第一条 before_agent_start 记录；
  // 其他用例沿用最后一条（模型可能在轮中自行换类别，那是它自己的动作）。
  const routeRec = c.name.startsWith("so-") ? (recs.find((r) => r.trigger === "before_agent_start") ?? last) : last;
  if (c.expectCategory && c.expectCategory !== "*") {
    check(
      `类别判定为 ${c.expectCategory}`,
      routeRec?.category === c.expectCategory,
      `实际 ${routeRec?.category}（依据 ${routeRec?.routedBy}）`,
    );
  }
  if (c.expectRoutedBy) {
    check(
      `判定依据为 ${c.expectRoutedBy}`,
      String(routeRec?.routedBy ?? "").startsWith(c.expectRoutedBy),
      `实际 ${routeRec?.routedBy}｜${routeRec?.routerNote ?? ""}`,
    );
  }
  if (c.name === "so-lowconf" || c.name === "so-down") {
    const noteRec = recs.filter((r) => r.routerNote).pop();
    const want = c.name === "so-lowconf" ? "置信度" : "端点不可用";
    check(`回退原因写进了日志（含「${want}」）`, String(noteRec?.routerNote ?? "").includes(want), `routerNote=${noteRec?.routerNote}`);
  }
  if (c.name.includes("on-demand")) {
    const want = "intercom";
    check(`按需挂载已落盘：${want}`, stateExtras.includes(want), `state 里的额外挂载：${stateExtras.join(", ") || "空"}`);
    check(
      `${want} 进入了本轮挂载集合`,
      (last?.mounted ?? []).includes(want),
      `本轮挂载：${(last?.mounted ?? []).join(", ")}`,
    );
  }
  if (c.name.includes("budget-absolute")) {
    // 预算绝对优先：显式挂 subagent（26,555 字符 > 预算）必须被丢弃
    const huge = "subagent";
    check(`超大工具已请求挂载：${huge}`, stateExtras.includes(huge), `state：${stateExtras.join(", ") || "空"}`);
    check(
      `预算绝对优先：${huge} 未被挂上`,
      !(last?.mounted ?? []).includes(huge),
      `本轮挂载：${(last?.mounted ?? []).join(", ")}`,
    );
    if (sys) {
      check(
        `进提示词的 schema 仍 ≤ ${c.budgetChars}`,
        sys.chars <= c.budgetChars,
        `实际 ${sys.chars} 字符（超大工具没有破预算）`,
      );
    }
  }

  results.push({
    case: c.name,
    session: file,
    tools: sys?.count ?? 0,
    schemaChars: sys?.chars ?? 0,
    approxTokens: sys ? Math.round(sys.chars / 4) : 0,
    category: last?.category ?? null,
    routedBy: last?.routedBy ?? null,
    mounted: last?.mounted ?? [],
    mountedChars: last?.mountedChars ?? 0,
    payloadMax: maxPayloadTools,
    payloadCharsMax: maxPayloadChars,
    unbucketed: last?.unbucketed?.length ?? null,
    records: recs.length,
    checks,
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), JSON.stringify(results, null, 2) + "\n");

const lines = ["# pi-tool-ladder E2E 报告", "", `生成时间：${new Date().toISOString()}`, ""];
lines.push("| 用例 | 类别 | 判定依据 | 进提示词工具数 | schema 字符 | ≈token | 载荷最多工具数 | 结果 |");
lines.push("|---|---|---|---:|---:|---:|---:|---|");
for (const r of results) {
  const ok = r.checks.every((c) => c.ok);
  lines.push(
    `| ${r.case} | ${r.category} | ${r.routedBy} | ${r.tools} | ${r.schemaChars} | ${r.approxTokens} | ${r.payloadMax} | ${ok ? "✅" : "❌"} |`,
  );
}
lines.push("", "## 逐条断言", "");
for (const r of results) {
  lines.push(`### ${r.case}`);
  for (const c of r.checks) lines.push(`- ${c.ok ? "✅" : "❌"} ${c.label} — ${c.detail}`);
  lines.push("");
}
writeFileSync(join(OUT, "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(failed === 0 ? "\nE2E 全部通过" : `\nE2E 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
