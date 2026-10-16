/**
 * E2E 用：模拟"以后工具、MCP、扩展继续暴涨"。
 * 注册 FAKE_COUNT 个扩展工具（名字与默认配置的 pattern 不匹配 → 应落进未归桶），
 * 以及若干仿 MCP 命名（server__tool 形式），用于验证阶梯不变量。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const FAKE_COUNT = Number(process.env.LADDER_FAKE_COUNT ?? 120);
const MCP_LIKE_COUNT = Number(process.env.LADDER_FAKE_MCP ?? 40);

function makeTool(name: string, blurb: string) {
  const noise =
    "Use this tool when you need to " + blurb + ". It accepts a target and returns structured output. " +
    "Prefer it over ad-hoc shell commands when the target is already known. " +
    "The tool is safe to retry; failures return a machine-readable error code. ";
  return {
    name,
    label: name,
    description: noise + noise,
    parameters: Type.Object({
      target: Type.String({ description: "目标，例如路径、编号或查询串；必填。" }),
      options: Type.Optional(Type.String({ description: "额外选项，逗号分隔；可选。".repeat(2) })),
      dryRun: Type.Optional(Type.Boolean({ description: "只预演不执行。" })),
    }),
    async execute(_id: string, params: { target: string }) {
      return { content: [{ type: "text", text: `${name} ok: ${JSON.stringify(params)}` }] };
    },
  } as never;
}

export default function fakeTools(pi: ExtensionAPI): void {
  for (let i = 0; i < FAKE_COUNT; i++) {
    pi.registerTool(makeTool(`future_ext_${i}_do`, `perform synthetic operation ${i}`));
  }
  for (let i = 0; i < MCP_LIKE_COUNT; i++) {
    // 仿 MCP 命名（带前缀），但故意不落进任何类别 pattern，验证未归桶兜底
    pi.registerTool(makeTool(`fakeserver${i % 5}__op_${i}`, `call remote MCP operation ${i}`));
  }
  console.log(`[fake-tools] 已注册 ${FAKE_COUNT} 个扩展工具 + ${MCP_LIKE_COUNT} 个仿 MCP 工具`);
}
