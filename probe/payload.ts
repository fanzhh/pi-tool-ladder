/**
 * 探针：看 provider 载荷的形状，确认工具字段名与体量。
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function payloadProbe(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    const p = event.payload as Record<string, unknown>;
    const tools = Array.isArray(p.tools) ? (p.tools as unknown[]) : undefined;
    const first = tools?.[0];
    const chars = tools ? JSON.stringify(tools).length : 0;
    console.log(
      "[payload] keys=" + Object.keys(p).join(",") +
      " | tools=" + (tools ? tools.length : "none") +
      " | tools chars=" + chars +
      " | tools[0]=" + (first ? JSON.stringify(first).slice(0, 200) : "n/a")
    );
    return undefined; // 不改动
  });
}
