/**
 * 最小探针：验证扩展能否在 prompt 进入模型前改掉活动工具集。
 * 期望：session 文件的 system 消息里 toolsAdded 只剩 read。
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function probe(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const all = pi.getAllTools();
    const active = pi.getActiveTools();
    console.log("[probe] all=" + all.length + " active=" + active.length);
    pi.setActiveTools(["read"]);
    console.log("[probe] after set, active=" + pi.getActiveTools().join(","));
    return {
      message: {
        customType: "ladder-probe",
        content:
          "[probe] 可用工具总数=" + all.length + "，本轮只挂载 read=" + pi.getActiveTools().join(","),
        display: false,
      },
    };
  });
}
