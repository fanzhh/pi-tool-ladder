/**
 * pi-tool-ladder 核心逻辑：分桶、分类、预算收紧。
 *
 * 纯函数，不碰 pi 的 API，便于在 E2E 里被真正跑到的扩展调用，
 * 也方便用脚本单独验证（scripts/ 下没有单元测试，验证一律走 e2e/）。
 */

export interface Category {
  id: string;
  label: string;
  priority: number;
  keywords: string[];
  patterns: string[];
  maxTools: number;
}

export interface LadderConfig {
  budget: { maxTools: number; maxSchemaChars: number; maxUnbucketed: number };
  alwaysOn: string[];
  controlTools: string[];
  router: { mode: string; sticky: string; classifyEndpoint: string };
  fallbackCategory: string;
  logPath: string;
  statePath: string;
  categories: Category[];
}

export interface ToolInfo {
  name: string;
  chars: number;
  source?: string;
}

export interface Decision {
  category: string;
  routedBy: string;
  score: number;
  mounted: string[];
  mountedChars: number;
  dropped: { name: string; reason: string }[];
  buckets: Record<string, number>;
  unbucketed: string[];
  configHash: string;
}

export const DEFAULT_BUDGET = { maxTools: 12, maxSchemaChars: 14000, maxUnbucketed: 0 };

/** 极简 glob：支持完全匹配、前缀 `x*`、后缀 `*x`、包含 `*x*`。 */
export function globMatch(pattern: string, name: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === name) return true;
  if (p.startsWith("*") && p.endsWith("*")) return name.includes(p.slice(1, -1));
  if (p.startsWith("*")) return name.endsWith(p.slice(1));
  if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
  return false;
}

export function mergeConfig(raw: Partial<LadderConfig>, fallback: LadderConfig): LadderConfig {
  return {
    budget: { ...fallback.budget, ...(raw.budget ?? {}) },
    alwaysOn: raw.alwaysOn ?? fallback.alwaysOn,
    controlTools: raw.controlTools ?? fallback.controlTools,
    router: { ...fallback.router, ...(raw.router ?? {}) },
    fallbackCategory: raw.fallbackCategory ?? fallback.fallbackCategory,
    logPath: raw.logPath ?? fallback.logPath,
    statePath: raw.statePath ?? fallback.statePath,
    categories: raw.categories ?? fallback.categories,
  };
}

/** 把可用工具按类别 pattern 归桶；没有匹配的进 unbucketed。 */
export function bucketTools(
  tools: ToolInfo[],
  cfg: LadderConfig,
): { buckets: Record<string, string[]>; unbucketed: ToolInfo[] } {
  const buckets: Record<string, string[]> = {};
  for (const c of cfg.categories) buckets[c.id] = [];
  const unbucketed: ToolInfo[] = [];

  for (const t of tools) {
    let placed = false;
    for (const c of [...cfg.categories].sort((a, b) => a.priority - b.priority)) {
      if (c.patterns.some((p) => globMatch(p, t.name))) {
        buckets[c.id].push(t.name);
        placed = true;
        break;
      }
    }
    if (!placed) unbucketed.push(t);
  }
  for (const id of Object.keys(buckets)) buckets[id].sort();
  return { buckets, unbucketed };
}

/** 关键词分类。返回得分最高者；全部为 0 时返回 fallback。 */
export function classifyByKeywords(
  prompt: string,
  cfg: LadderConfig,
): { category: string; score: number; hits: string[] } {
  const text = (prompt ?? "").toLowerCase();
  let best = { category: cfg.fallbackCategory, score: 0, hits: [] as string[] };

  for (const c of cfg.categories) {
    if (c.id === cfg.fallbackCategory) continue;
    const hits = c.keywords.filter((k) => k && text.includes(k.toLowerCase()));
    if (hits.length > best.score) best = { category: c.id, score: hits.length, hits };
  }
  return best;
}

/** 在预算内挑要挂载的工具：alwaysOn + 控制工具 + 选中类别，再按字符上限收紧。 */
export function planMount(
  tools: ToolInfo[],
  cfg: LadderConfig,
  category: string,
  extra: string[] = [],
): Decision {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const { buckets, unbucketed } = bucketTools(tools, cfg);
  const cat = cfg.categories.find((c) => c.id === category);
  const mounted: string[] = [];
  const dropped: { name: string; reason: string }[] = [];

  const push = (name: string, reason: string) => {
    const t = byName.get(name);
    if (!t) {
      dropped.push({ name, reason: "工具不存在：" + reason });
      return;
    }
    if (!mounted.includes(name)) mounted.push(name);
  };

  // 显式指定的一律保留：alwaysOn、阶梯控制工具、按需挂载。它们代表明确的意图，
  // 不能被字符预算悄悄丢掉；预算只用来裁剪"类别自动填充"的部分。
  const explicit: string[] = [];
  for (const n of cfg.alwaysOn) push(n, "alwaysOn");
  for (const n of cfg.controlTools) push(n, "阶梯控制工具");
  for (const n of extra) push(n, "按需挂载");
  explicit.push(...mounted);

  if (cat) {
    for (const n of (buckets[cat.id] ?? []).slice(0, cat.maxTools)) push(n, "类别 " + cat.id);
  }
  // 未归桶的工具：受 maxUnbucketed 限制，默认一个都不挂（新扩展再多也顶不破预算）
  const unbucketedAllowed = unbucketed
    .filter(() => cfg.budget.maxUnbucketed > 0)
    .slice(0, Math.max(0, cfg.budget.maxUnbucketed))
    .map((t) => t.name);
  for (const n of unbucketedAllowed) push(n, "未归桶（受 maxUnbucketed 限制）");
  for (const t of unbucketed) {
    if (!mounted.includes(t.name)) dropped.push({ name: t.name, reason: "未归桶，不自动挂载" });
  }

  // 硬预算：先按工具数，再按 schema 字符数收紧
  const withinCount = mounted.slice(0, Math.max(0, cfg.budget.maxTools));
  for (const n of mounted.slice(withinCount.length)) {
    dropped.push({
      name: n,
      reason: explicit.includes(n) ? "超出 maxTools（显式挂载）" : "超出 maxTools=" + cfg.budget.maxTools,
    });
  }

  const kept: string[] = [];
  let used = 0;
  for (const n of withinCount) {
    const size = byName.get(n)?.chars ?? 0;
    if (used + size > cfg.budget.maxSchemaChars && kept.length > 0 && !explicit.includes(n)) {
      dropped.push({ name: n, reason: "超出 maxSchemaChars=" + cfg.budget.maxSchemaChars });
      continue;
    }
    kept.push(n);
    used += size;
  }

  return {
    category: cat ? cat.id : cfg.fallbackCategory,
    routedBy: "pending",
    score: 0,
    mounted: kept,
    mountedChars: used,
    dropped,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    unbucketed: unbucketed.map((t) => t.name),
    configHash: hashConfig(cfg),
  };
}

/** 便宜的配置指纹，用于在日志里判断"配置变了没"。 */
export function hashConfig(cfg: LadderConfig): string {
  const s = JSON.stringify(cfg);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
